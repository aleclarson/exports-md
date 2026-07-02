#!/usr/bin/env node
import { binary, command, option, optional, positional, restPositionals, run, string } from 'cmd-ts'
import { File } from 'cmd-ts/batteries/fs'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from 'node:path'
import type { Diagnostic, Identifier, SourceFile, Statement } from 'typescript'

type TypeScript = typeof import('typescript')
const cacheVersion = 3
const packageVersion = '0.0.0'

export interface GeneratedMarkdown {
  declaration: string
  fromCache: boolean
  inputFile: string
  markdown: string
}

export interface GenerateMarkdownOptions {
  cwd?: string
  outDir?: string
  symbols?: string[]
}

interface TsDocTag {
  name: string
  text: string
}

interface TsDoc {
  body: string
  tags: TsDocTag[]
}

interface DeclarationEntry {
  code: string
  exportedName: string
  index: number
  isExported: boolean
  localName: string
  statement: Statement
}

interface ImportEntry {
  code: string
  importedNames: Set<string>
  index: number
  statement: Statement
}

interface ReExportEntry {
  code: string
  exportedNames: Set<string>
  exportsAll: boolean
  index: number
  statement: Statement
}

interface CachedMarkdown {
  declaration: string
  markdown: string
}

interface PackageMarkdownEntry {
  inputFile: string
  markdown: string
}

interface PackageEntryPoint {
  exportSubpath: string
  inputFile: string
}

export async function generateMarkdownForModule(
  modulePath: string,
  options: GenerateMarkdownOptions = {},
): Promise<GeneratedMarkdown> {
  const cwd = resolve(options.cwd ?? process.cwd())
  const inputFile = resolve(cwd, modulePath)
  const symbols = normalizeSymbols(options.symbols ?? [])

  if (isPackageJson(inputFile)) {
    return generateMarkdownForPackage(inputFile, cwd, symbols, options.outDir)
  }

  if (options.outDir) {
    throw new Error('--outDir is only supported for package.json input.')
  }

  return generateMarkdownForDeclarationFile(inputFile, cwd, symbols)
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

async function generateMarkdownForPackage(
  packageJsonFile: string,
  cwd: string,
  symbols: readonly string[],
  outDir?: string,
): Promise<GeneratedMarkdown> {
  if (symbols.length > 0) {
    throw new Error('Symbol filters are only supported for TypeScript module input.')
  }

  const packageJson = await readPackageJson(packageJsonFile)
  const packageName = getPackageName(packageJson, packageJsonFile)
  const entryPoints = readPackageEntryPoints(packageJsonFile, packageJson)
  const entries = await Promise.all(
    entryPoints.map(
      async ({ exportSubpath, inputFile }): Promise<PackageMarkdownEntry & GeneratedMarkdown> => {
        const heading = getPackageEntryHeading(packageName, exportSubpath)
        return generateMarkdownForDeclarationFile(inputFile, cwd, symbols, heading)
      },
    ),
  )
  const markdown = `${entries
    .map((entry) => entry.markdown.trimEnd())
    .join('\n\n')
    .trimEnd()}\n`

  if (outDir) {
    await writePackageMarkdownFiles(entries, resolve(cwd, outDir))
  }

  return {
    declaration: entries.map((entry) => entry.declaration).join('\n\n'),
    fromCache: entries.every((entry) => entry.fromCache),
    inputFile: packageJsonFile,
    markdown,
  }
}

async function generateMarkdownForDeclarationFile(
  inputFile: string,
  cwd: string,
  symbols: readonly string[],
  heading = basename(inputFile),
): Promise<GeneratedMarkdown> {
  assertTypeScriptModule(inputFile)
  const cacheFile = await getCacheFile(inputFile, cwd, symbols, heading)
  const cached = await readCache(cacheFile)
  if (cached) {
    return {
      declaration: cached.declaration,
      fromCache: true,
      inputFile,
      markdown: cached.markdown,
    }
  }

  const ts = loadWorkspaceTypescript(cwd)
  const declaration = isDeclarationFile(inputFile)
    ? await readFile(inputFile, 'utf8')
    : compileDeclaration(ts, inputFile, cwd)
  const markdown = declarationToMarkdown(ts, declaration, heading, symbols)

  await writeCache(cacheFile, { declaration, markdown })

  return {
    declaration,
    fromCache: false,
    inputFile,
    markdown,
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

function declarationToMarkdown(
  ts: TypeScript,
  declaration: string,
  heading: string,
  requestedSymbols: readonly string[] = [],
) {
  const sourceFile = ts.createSourceFile('module.d.ts', declaration, ts.ScriptTarget.Latest, true)
  const { declarations, imports, reExports } = indexDeclarationFile(ts, declaration, sourceFile)
  const requested = new Set(requestedSymbols)
  const externalExportNames = new Set(reExports.flatMap((entry) => [...entry.exportedNames]))
  // `export * from` can satisfy a symbol query, but the emitted line does not reveal its names.
  const hasUnknownExternalExports = reExports.some((entry) => entry.exportsAll)
  const included = selectDeclarationEntries(
    ts,
    declarations,
    requested,
    externalExportNames,
    hasUnknownExternalExports,
  )
  const includedReExports = selectReExportEntries(reExports, requested)
  const importedNames = collectReferencedImportedNames(ts, included, imports, declarations)
  const includedImports = imports.filter((entry) =>
    [...entry.importedNames].some((name) => importedNames.has(name)),
  )
  const referenceEntries = [...includedImports, ...includedReExports].sort(
    (left, right) => left.index - right.index,
  )
  const sections: string[] = [`# ${heading}`]

  if (referenceEntries.length > 0) {
    sections.push(renderCodeBlock(referenceEntries.map((entry) => entry.code).join('\n')))
  }

  for (const entry of included) {
    const { statement } = entry
    const localName = getStatementName(ts, statement)
    if (!localName) continue

    const comment = getLeadingTsDoc(ts, declaration, statement)
    const docs = comment ? renderTsDoc(parseTsDoc(comment)) : ''

    sections.push(renderDeclarationSection(entry.exportedName, docs, entry.code))
  }

  return `${sections.join('\n\n').trimEnd()}\n`
}

function readPackageEntryPoints(packageJsonFile: string, packageJson: { exports?: unknown }) {
  const packageRoot = dirname(packageJsonFile)
  const exportsField = packageJson.exports

  if (exportsField === undefined) {
    throw new Error(`Package exports not found: ${packageJsonFile}`)
  }

  const entryPoints: PackageEntryPoint[] = []

  if (isRecord(exportsField) && Object.keys(exportsField).some((key) => key.startsWith('.'))) {
    for (const [subpath, value] of Object.entries(exportsField)) {
      const entryTargets = collectDeclarationTargets(value)
      if (entryTargets.length === 0) {
        throw new Error(`Could not derive a declaration entry point from exports["${subpath}"].`)
      }
      for (const target of entryTargets) {
        entryPoints.push({
          exportSubpath: subpath,
          inputFile: resolvePackageTarget(packageRoot, target),
        })
      }
    }
  } else {
    for (const target of collectDeclarationTargets(exportsField)) {
      entryPoints.push({
        exportSubpath: '.',
        inputFile: resolvePackageTarget(packageRoot, target),
      })
    }
  }

  if (entryPoints.length === 0) {
    throw new Error(`Could not derive declaration entry points from ${packageJsonFile}`)
  }

  const uniqueEntryPoints = new Map(
    entryPoints.map((entryPoint) => [
      `${entryPoint.exportSubpath}\0${entryPoint.inputFile}`,
      entryPoint,
    ]),
  )

  return [...uniqueEntryPoints.values()]
}

async function readPackageJson(packageJsonFile: string) {
  try {
    return JSON.parse(await readFile(packageJsonFile, 'utf8')) as {
      exports?: unknown
      name?: unknown
    }
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(`Invalid package.json: ${packageJsonFile}`)
    }
    throw error
  }
}

function getPackageName(packageJson: { name?: unknown }, packageJsonFile: string) {
  if (typeof packageJson.name === 'string' && packageJson.name.length > 0) {
    return packageJson.name
  }

  throw new Error(`Package name not found: ${packageJsonFile}`)
}

function getPackageEntryHeading(packageName: string, exportSubpath: string) {
  if (exportSubpath === '.') return packageName

  return `${packageName}/${exportSubpath.replace(/^\.\//, '')}`
}

function collectDeclarationTargets(value: unknown): string[] {
  if (typeof value === 'string') {
    const declarationTarget = toDeclarationTarget(value)
    return declarationTarget ? [declarationTarget] : []
  }

  if (Array.isArray(value)) {
    return value.flatMap((item) => collectDeclarationTargets(item))
  }

  if (!isRecord(value)) return []

  if (typeof value.types === 'string') {
    return [value.types]
  }

  return Object.entries(value).flatMap(([key, nested]) =>
    key === 'types' ? [] : collectDeclarationTargets(nested),
  )
}

function toDeclarationTarget(target: string) {
  if (isDeclarationFile(target) || ['.ts', '.mts', '.cts', '.tsx'].includes(extname(target))) {
    return target
  }

  if (target.endsWith('.js')) {
    return `${target.slice(0, -'.js'.length)}.d.ts`
  }

  if (target.endsWith('.mjs')) {
    return `${target.slice(0, -'.mjs'.length)}.d.ts`
  }
}

function resolvePackageTarget(packageRoot: string, target: string) {
  if (!target.startsWith('./')) {
    throw new Error(`Package export target must be relative to the package root: ${target}`)
  }

  return resolve(packageRoot, target)
}

async function writePackageMarkdownFiles(entries: PackageMarkdownEntry[], outDir: string) {
  const commonRoot = getCommonRoot(entries.map((entry) => entry.inputFile))

  await Promise.all(
    entries.map(async (entry) => {
      const outputFile = join(
        outDir,
        replaceEntryPointExtension(relative(commonRoot, entry.inputFile)),
      )
      mkdirSync(dirname(outputFile), { recursive: true })
      await writeFile(outputFile, entry.markdown)
    }),
  )
}

function getCommonRoot(paths: readonly string[]) {
  if (paths.length === 0) {
    throw new Error('Cannot find a common root without entry points.')
  }

  let common = dirname(paths[0]!)

  for (const path of paths.slice(1)) {
    const directory = dirname(path)
    while (!isSameOrChildPath(common, directory)) {
      const parent = dirname(common)
      if (parent === common) return common
      common = parent
    }
  }

  return common
}

function isSameOrChildPath(parent: string, child: string) {
  const path = relative(parent, child)
  return path === '' || (!path.startsWith('..') && !isAbsolute(path))
}

function replaceEntryPointExtension(path: string) {
  if (path.endsWith('.d.ts')) {
    return `${path.slice(0, -'.d.ts'.length)}.md`
  }

  if (path.endsWith('.d.mts')) {
    return `${path.slice(0, -'.d.mts'.length)}.md`
  }

  if (path.endsWith('.d.cts')) {
    return `${path.slice(0, -'.d.cts'.length)}.md`
  }

  const extension = extname(path)
  return `${path.slice(0, -extension.length)}.md`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
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

function collectExports(ts: TypeScript, sourceFile: SourceFile) {
  const exportsByLocalName = new Map<string, string>()

  for (const statement of sourceFile.statements) {
    if (!ts.isExportDeclaration(statement)) continue
    if (statement.moduleSpecifier) continue
    const clause = statement.exportClause
    if (!clause || !ts.isNamedExports(clause)) continue

    for (const element of clause.elements) {
      const localName = element.propertyName?.text ?? element.name.text
      exportsByLocalName.set(localName, element.name.text)
    }
  }

  return exportsByLocalName
}

function indexDeclarationFile(ts: TypeScript, declaration: string, sourceFile: SourceFile) {
  const exportsByLocalName = collectExports(ts, sourceFile)
  const declarations: DeclarationEntry[] = []
  const imports: ImportEntry[] = []
  const reExports: ReExportEntry[] = []

  sourceFile.statements.forEach((statement, index) => {
    if (ts.isExportDeclaration(statement)) {
      if (statement.moduleSpecifier) {
        reExports.push({
          code: declaration.slice(statement.getStart(sourceFile), statement.end).trim(),
          exportedNames: collectExportedNames(ts, statement),
          exportsAll: !statement.exportClause,
          index,
          statement,
        })
      }
      return
    }

    if (ts.isImportDeclaration(statement)) {
      const importedNames = collectImportedNames(ts, statement)
      if (importedNames.size > 0) {
        imports.push({
          code: declaration.slice(statement.getStart(sourceFile), statement.end).trim(),
          importedNames,
          index,
          statement,
        })
      }
      return
    }

    const localName = getStatementName(ts, statement)
    if (!localName) return

    const exportedName = exportsByLocalName.get(localName) ?? localName
    const isExported = hasExportModifier(ts, statement) || exportsByLocalName.has(localName)
    declarations.push({
      code: declaration.slice(statement.getStart(sourceFile), statement.end).trim(),
      exportedName,
      index,
      isExported,
      localName,
      statement,
    })
  })

  return {
    declarations,
    imports,
    reExports,
  }
}

function collectExportedNames(ts: TypeScript, statement: Statement) {
  const names = new Set<string>()
  if (!ts.isExportDeclaration(statement)) return names

  const clause = statement.exportClause
  if (!clause) return names

  if (ts.isNamespaceExport(clause)) {
    names.add(clause.name.text)
    return names
  }

  for (const element of clause.elements) {
    names.add(element.name.text)
  }

  return names
}

function collectImportedNames(ts: TypeScript, statement: Statement) {
  const names = new Set<string>()
  if (!ts.isImportDeclaration(statement)) return names

  const clause = statement.importClause
  if (!clause) return names

  if (clause.name) {
    names.add(clause.name.text)
  }

  const bindings = clause.namedBindings
  if (!bindings) return names

  if (ts.isNamespaceImport(bindings)) {
    names.add(bindings.name.text)
    return names
  }

  for (const element of bindings.elements) {
    names.add(element.name.text)
  }

  return names
}

function selectDeclarationEntries(
  ts: TypeScript,
  declarations: DeclarationEntry[],
  requested: ReadonlySet<string>,
  externalExportNames: ReadonlySet<string> = new Set(),
  hasUnknownExternalExports = false,
) {
  const exportedDeclarations = declarations.filter((entry) => entry.isExported)
  const byLocalName = new Map(declarations.map((entry) => [entry.localName, entry]))
  const exportedByLocalName = new Map(exportedDeclarations.map((entry) => [entry.localName, entry]))
  const byExportedName = new Map(exportedDeclarations.map((entry) => [entry.exportedName, entry]))
  const included = new Set<DeclarationEntry>()
  const pending =
    requested.size === 0
      ? [...exportedDeclarations]
      : [...requested].map(
          (symbol) => byExportedName.get(symbol) ?? exportedByLocalName.get(symbol),
        )

  for (const symbol of requested) {
    if (
      !byExportedName.has(symbol) &&
      !exportedByLocalName.has(symbol) &&
      !externalExportNames.has(symbol) &&
      !hasUnknownExternalExports
    ) {
      throw new Error(`Export not found: ${symbol}`)
    }
  }

  while (pending.length > 0) {
    const entry = pending.pop()
    if (!entry || included.has(entry)) continue

    included.add(entry)

    for (const identifier of collectIdentifiers(ts, entry.statement)) {
      const dependency = byLocalName.get(identifier.text)
      if (dependency && dependency !== entry && !included.has(dependency)) {
        pending.push(dependency)
      }
    }
  }

  return [...included].sort((left, right) => left.index - right.index)
}

function selectReExportEntries(reExports: ReExportEntry[], requested: ReadonlySet<string>) {
  if (requested.size === 0) return reExports

  return reExports.filter(
    (entry) =>
      entry.exportsAll ||
      [...entry.exportedNames].some((exportedName) => requested.has(exportedName)),
  )
}

function collectReferencedImportedNames(
  ts: TypeScript,
  declarations: DeclarationEntry[],
  imports: ImportEntry[],
  localDeclarations: DeclarationEntry[],
) {
  const importedNames = new Set(imports.flatMap((entry) => [...entry.importedNames]))
  const localNames = new Set(localDeclarations.map((entry) => entry.localName))
  const referenced = new Set<string>()

  for (const declaration of declarations) {
    for (const identifier of collectIdentifiers(ts, declaration.statement)) {
      if (importedNames.has(identifier.text) && !localNames.has(identifier.text)) {
        referenced.add(identifier.text)
      }
    }
  }

  return referenced
}

function collectIdentifiers(ts: TypeScript, statement: Statement) {
  const identifiers: Identifier[] = []

  function visit(node: Parameters<typeof ts.forEachChild>[0]) {
    if (ts.isIdentifier(node)) {
      identifiers.push(node)
    }

    ts.forEachChild(node, visit)
  }

  ts.forEachChild(statement, visit)
  return identifiers
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
  return [`## \`${name}\``, docs, renderCodeBlock(code)].filter(Boolean).join('\n\n')
}

function renderCodeBlock(code: string) {
  return `\`\`\`ts\n${code}\n\`\`\``
}

async function getCacheFile(
  inputFile: string,
  cwd: string,
  symbols: readonly string[],
  heading: string,
) {
  const source = await readFile(inputFile, 'utf8')
  const configPath = findTsConfig(inputFile, cwd)
  const config = configPath ? readFileSync(configPath, 'utf8') : ''
  const hash = createHash('sha256')
    .update(packageVersion)
    .update('\0')
    .update(cacheVersion.toString())
    .update('\0')
    .update(inputFile)
    .update('\0')
    .update(source)
    .update('\0')
    .update(configPath ?? '')
    .update('\0')
    .update(config)
    .update('\0')
    .update(JSON.stringify(symbols))
    .update('\0')
    .update(heading)
    .digest('hex')

  return join(tmpdir(), 'exports-md', `${hash}.json`)
}

function findTsConfig(inputFile: string, cwd: string) {
  let dir = dirname(inputFile)
  const stop = dirname(resolve(cwd))

  while (true) {
    const candidate = join(dir, 'tsconfig.json')
    if (isFile(candidate)) return candidate

    const parent = dirname(dir)
    if (dir === parent || dir === stop) return undefined
    dir = parent
  }
}

async function readCache(file: string): Promise<CachedMarkdown | undefined> {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as CachedMarkdown
  } catch {
    return undefined
  }
}

async function writeCache(file: string, data: CachedMarkdown) {
  mkdirSync(dirname(file), { recursive: true })
  await writeFile(file, JSON.stringify(data))
}

function normalizeSymbols(symbols: readonly string[]) {
  return symbols.map((symbol) => symbol.trim()).filter(Boolean)
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

function isPackageJson(path: string) {
  return basename(path) === 'package.json'
}

function isDeclarationFile(path: string) {
  return path.endsWith('.d.ts') || path.endsWith('.d.mts') || path.endsWith('.d.cts')
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
  description: 'Print Markdown docs for TypeScript module exports.',
  args: {
    module: positional({
      type: File,
      displayName: 'input',
      description: 'TypeScript module or package.json to document.',
    }),
    outDir: option({
      type: optional(string),
      long: 'outDir',
      short: 'o',
      description: 'Write package entry Markdown files to this directory.',
    }),
    symbols: restPositionals({
      type: string,
      displayName: 'symbol',
      description: 'Export symbol names to include.',
    }),
  },
  async handler({ module, outDir, symbols }) {
    const result = await generateMarkdownForModule(module, { outDir, symbols })
    if (!outDir) {
      process.stdout.write(result.markdown)
    }
  },
})

if (import.meta.main) {
  await run(binary(app), process.argv)
}
