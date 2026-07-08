#!/usr/bin/env node
import { binary, command, flag, oneOf, option, optional, run, string } from 'cmd-ts'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from 'node:path'
import type {
  CompilerOptions,
  Diagnostic,
  Identifier,
  Node,
  SourceFile,
  Statement,
} from 'typescript'

type TypeScript = typeof import('typescript')
const cacheVersion = 6
const packageVersion = '0.0.0'
export type PropertyDocMode = 'inline' | 'list'

const propertyDocModes = ['inline', 'list'] as const satisfies readonly PropertyDocMode[]

export interface GeneratedMarkdown {
  declaration: string
  fromCache: boolean
  inputFile: string
  markdown: string
}

export interface GenerateMarkdownOptions {
  cwd?: string
  followImports?: boolean
  followReExports?: boolean
  outDir?: string
  propertyDocs?: PropertyDocMode
  reverseSymbols?: boolean
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
  importedNameAliases: Map<string, string>
  importedNames: Set<string>
  index: number
  moduleSpecifier: string
  statement: Statement
}

interface ReExportEntry {
  code: string
  exportedNames: Set<string>
  exportsAll: boolean
  index: number
  moduleSpecifier: string
  statement: Statement
}

interface ImportedReExportEntry {
  exportedName: string
  importEntry: ImportEntry
  sourceName: string
}

interface CachedMarkdown {
  declaration: string
  markdown: string
}

interface PackageMarkdownEntry {
  declaration: string
  foundSymbols: Set<string>
  fromCache: boolean
  inputFile: string
  markdown: string
}

interface PackageEntryPoint {
  exportSubpath: string
  inputFile: string
}

interface PropertyDoc {
  name: string
  docs: string
}

interface CodeEdit {
  end: number
  replacement: string
  start: number
}

interface CliNode {
  raw: string
  type: string
}

interface CliParseContext {
  nodes: CliNode[]
  visitedNodes: Set<CliNode>
}

interface CliInputsAndSymbols {
  inputs: string[]
  symbols: string[]
}

export async function generateMarkdownForModule(
  modulePath: string,
  options: GenerateMarkdownOptions = {},
): Promise<GeneratedMarkdown> {
  return generateMarkdownForInput(modulePath, options)
}

async function generateMarkdownForInput(
  modulePath: string,
  options: GenerateMarkdownOptions = {},
  allowMissingSymbols = false,
): Promise<GeneratedMarkdown & { foundSymbols: Set<string> }> {
  const cwd = resolve(options.cwd ?? process.cwd())
  const inputFile = resolve(cwd, modulePath)
  const symbols = normalizeSymbols(options.symbols ?? [])
  const followImports = options.followImports ?? isPackageJson(inputFile)
  const followReExports = options.followReExports ?? isPackageJson(inputFile)
  const propertyDocs = options.propertyDocs ?? 'inline'
  const reverseSymbols = options.reverseSymbols ?? false

  if (isPackageJson(inputFile)) {
    return generateMarkdownForPackage(
      inputFile,
      cwd,
      symbols,
      followImports,
      followReExports,
      propertyDocs,
      reverseSymbols,
      options.outDir,
      allowMissingSymbols,
    )
  }

  if (options.outDir) {
    throw new Error('--outDir is only supported for package.json input.')
  }

  return generateMarkdownForDeclarationFile(
    inputFile,
    cwd,
    symbols,
    followImports,
    followReExports,
    propertyDocs,
    reverseSymbols,
    undefined,
    allowMissingSymbols,
  )
}

async function generateMarkdownForInputs(
  modulePaths: readonly string[],
  options: GenerateMarkdownOptions = {},
): Promise<GeneratedMarkdown> {
  if (modulePaths.length === 0) {
    throw new Error('At least one input is required.')
  }

  if (modulePaths.length === 1) {
    return generateMarkdownForModule(modulePaths[0]!, options)
  }

  if (options.outDir) {
    throw new Error('--outDir is only supported for a single package.json input.')
  }

  const entries = await Promise.all(
    modulePaths.map((modulePath) => generateMarkdownForInput(modulePath, options, true)),
  )
  const symbols = normalizeSymbols(options.symbols ?? [])
  const foundSymbols = new Set(entries.flatMap((entry) => [...entry.foundSymbols]))

  for (const symbol of symbols) {
    if (!foundSymbols.has(symbol)) {
      throw new Error(`Export not found: ${symbol}`)
    }
  }

  const includedEntries =
    symbols.length === 0 ? entries : entries.filter((entry) => entry.foundSymbols.size > 0)
  const markdown = `${includedEntries
    .map((entry) => entry.markdown.trimEnd())
    .join('\n\n')
    .trimEnd()}\n`

  return {
    declaration: includedEntries.map((entry) => entry.declaration).join('\n\n'),
    fromCache: includedEntries.every((entry) => entry.fromCache),
    inputFile: includedEntries.map((entry) => entry.inputFile).join('\n'),
    markdown,
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

async function generateMarkdownForPackage(
  packageJsonFile: string,
  cwd: string,
  symbols: readonly string[],
  followImports: boolean,
  followReExports: boolean,
  propertyDocs: PropertyDocMode,
  reverseSymbols: boolean,
  outDir?: string,
  allowMissingSymbols = false,
): Promise<GeneratedMarkdown & { foundSymbols: Set<string> }> {
  const packageJson = await readPackageJson(packageJsonFile)
  const packageName = getPackageName(packageJson, packageJsonFile)
  const entryPoints = readPackageEntryPoints(packageJsonFile, packageJson)
  const entries = await Promise.all(
    entryPoints.map(
      async ({ exportSubpath, inputFile }): Promise<PackageMarkdownEntry & GeneratedMarkdown> => {
        const heading = getPackageEntryHeading(packageName, exportSubpath)
        return generateMarkdownForDeclarationFile(
          inputFile,
          cwd,
          symbols,
          followImports,
          followReExports,
          propertyDocs,
          reverseSymbols,
          heading,
          symbols.length > 0 || allowMissingSymbols,
        )
      },
    ),
  )
  const foundSymbols = new Set(entries.flatMap((entry) => [...entry.foundSymbols]))

  if (!allowMissingSymbols) {
    for (const symbol of symbols) {
      if (!foundSymbols.has(symbol)) {
        throw new Error(`Export not found: ${symbol}`)
      }
    }
  }

  const includedEntries =
    symbols.length === 0 ? entries : entries.filter((entry) => entry.foundSymbols.size > 0)
  const markdown = `${includedEntries
    .map((entry) => entry.markdown.trimEnd())
    .join('\n\n')
    .trimEnd()}\n`

  if (outDir) {
    await writePackageMarkdownFiles(includedEntries, resolve(cwd, outDir))
  }

  return {
    declaration: includedEntries.map((entry) => entry.declaration).join('\n\n'),
    foundSymbols,
    fromCache: includedEntries.every((entry) => entry.fromCache),
    inputFile: packageJsonFile,
    markdown,
  }
}

async function generateMarkdownForDeclarationFile(
  inputFile: string,
  cwd: string,
  symbols: readonly string[],
  followImports: boolean,
  followReExports: boolean,
  propertyDocs: PropertyDocMode,
  reverseSymbols: boolean,
  heading = basename(inputFile),
  allowMissingSymbols = false,
): Promise<GeneratedMarkdown & { foundSymbols: Set<string> }> {
  assertTypeScriptModule(inputFile)
  const listPropertyDocs = propertyDocs === 'list'
  const cacheFile =
    listPropertyDocs || allowMissingSymbols || followImports || followReExports
      ? undefined
      : await getCacheFile(inputFile, cwd, symbols, heading, reverseSymbols)
  const cached = cacheFile ? await readCache(cacheFile) : undefined
  if (cached) {
    return {
      declaration: cached.declaration,
      foundSymbols: new Set(symbols),
      fromCache: true,
      inputFile,
      markdown: cached.markdown,
    }
  }

  const ts = loadWorkspaceTypescript(cwd)
  const declaration = isDeclarationFile(inputFile)
    ? await readFile(inputFile, 'utf8')
    : compileDeclaration(ts, inputFile, cwd)
  const foundSymbols =
    symbols.length === 0
      ? new Set<string>()
      : collectAvailableRequestedSymbols(ts, declaration, inputFile, symbols)
  const renderSymbols = allowMissingSymbols ? [...foundSymbols] : symbols
  const markdown =
    allowMissingSymbols && symbols.length > 0 && foundSymbols.size === 0
      ? `# ${heading}\n`
      : await declarationToMarkdown(ts, declaration, heading, renderSymbols, {
          cwd,
          followImports,
          followReExports,
          inputFile,
          propertyDocs,
          reverseSymbols,
          visited: new Set([resolve(inputFile)]),
        })

  if (cacheFile) {
    await writeCache(cacheFile, { declaration, markdown })
  }

  return {
    declaration,
    foundSymbols,
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
  const options = getCompilerOptions(ts, inputFile, cwd)
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
  context?: RenderContext,
) {
  return renderDeclarationMarkdown(ts, declaration, heading, requestedSymbols, context)
}

function collectAvailableRequestedSymbols(
  ts: TypeScript,
  declaration: string,
  inputFile: string,
  requestedSymbols: readonly string[],
) {
  const sourceFile = ts.createSourceFile(inputFile, declaration, ts.ScriptTarget.Latest, true)
  const { declarations, importedReExports, reExports } = indexDeclarationFile(
    ts,
    declaration,
    sourceFile,
  )
  const exportedDeclarations = declarations.filter((entry) => entry.isExported)
  const byExportedName = new Set(exportedDeclarations.map((entry) => entry.exportedName))
  const byLocalName = new Set(exportedDeclarations.map((entry) => entry.localName))
  const externalExportNames = new Set([
    ...reExports.flatMap((entry) => [...entry.exportedNames]),
    ...importedReExports.map((entry) => entry.exportedName),
  ])
  const hasUnknownExternalExports = reExports.some((entry) => entry.exportsAll)

  return new Set(
    requestedSymbols.filter(
      (symbol) =>
        byExportedName.has(symbol) ||
        byLocalName.has(symbol) ||
        externalExportNames.has(symbol) ||
        hasUnknownExternalExports,
    ),
  )
}

interface RenderContext {
  cwd: string
  followImports: boolean
  followReExports: boolean
  inputFile: string
  propertyDocs: PropertyDocMode
  reverseSymbols: boolean
  visited: Set<string>
}

async function renderDeclarationMarkdown(
  ts: TypeScript,
  declaration: string,
  heading: string,
  requestedSymbols: readonly string[] = [],
  context?: RenderContext,
) {
  const sections = [`# ${heading}`]
  sections.push(...(await renderDeclarationBody(ts, declaration, requestedSymbols, context)))

  return `${sections.join('\n\n').trimEnd()}\n`
}

async function renderDeclarationBody(
  ts: TypeScript,
  declaration: string,
  requestedSymbols: readonly string[] = [],
  context?: RenderContext,
  exportedNameOverrides: ReadonlyMap<string, string> = new Map(),
  renderExportModifiers = true,
) {
  const sourceFile = ts.createSourceFile(
    context?.inputFile ?? 'module.d.ts',
    declaration,
    ts.ScriptTarget.Latest,
    true,
  )
  const { declarations, importedReExports, imports, reExports } = indexDeclarationFile(
    ts,
    declaration,
    sourceFile,
  )
  const requested = new Set(requestedSymbols)
  const externalExportNames = new Set([
    ...reExports.flatMap((entry) => [...entry.exportedNames]),
    ...importedReExports.map((entry) => entry.exportedName),
  ])
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
  const followedReExports = context?.followReExports
    ? await renderFollowedReExportSections(ts, includedReExports, requested, context)
    : { followed: new Set<ReExportEntry>(), sections: [] }
  const unresolvedReExports = context?.followReExports
    ? includedReExports.filter((entry) => !followedReExports.followed.has(entry))
    : includedReExports
  const includedImportedReExports = selectImportedReExportEntries(importedReExports, requested)
  const followedImportedReExports = context?.followReExports
    ? await renderFollowedImportedReExportSections(
        ts,
        includedImportedReExports,
        importedReExports,
        context,
      )
    : { followed: new Set<ImportedReExportEntry>(), sections: [] }
  const importedNames = collectReferencedImportedNames(ts, included, imports, declarations)
  const includedImports = imports.filter((entry) =>
    [...entry.importedNames].some((name) => importedNames.has(name)),
  )
  const followedImports = context?.followImports
    ? await renderFollowedImportSections(ts, includedImports, importedNames, context)
    : { followed: new Set<ImportEntry>(), sections: [] }
  const unresolvedImports = context?.followImports
    ? includedImports.filter((entry) => !followedImports.followed.has(entry))
    : includedImports
  const referenceEntries = [...unresolvedImports, ...unresolvedReExports].sort(
    (left, right) => left.index - right.index,
  )
  const sections: string[] = []

  if (referenceEntries.length > 0) {
    sections.push(renderCodeBlock(referenceEntries.map((entry) => entry.code).join('\n')))
  }

  const includedWithOverrides = included.map((entry) => ({
    ...entry,
    exportedName: getRenderedExportedName(entry, exportedNameOverrides),
  }))

  const declarationSections: string[] = []

  for (const entries of groupDeclarationEntries(includedWithOverrides)) {
    const entry = entries[0]!
    const { statement } = entry
    const localName = getStatementName(ts, statement)
    if (!localName) continue

    const documentedEntry =
      entries.find((entry) => getLeadingTsDoc(ts, declaration, entry.statement)) ?? entry
    const comment = getLeadingTsDoc(ts, declaration, documentedEntry.statement)
    const docs = comment ? renderTsDoc(parseTsDoc(comment)) : ''
    const propertyDocs =
      context?.propertyDocs === 'list'
        ? entries.flatMap((entry) => collectPropertyDocs(ts, declaration, entry.statement))
        : []
    const code = entries
      .map((entry) => {
        const propertyDocCommentEdits =
          context?.propertyDocs === 'list'
            ? collectPropertyDocCommentEdits(ts, declaration, entry.statement)
            : []
        return renderDeclarationCode(
          ts,
          entry,
          exportedNameOverrides,
          renderExportModifiers,
          propertyDocCommentEdits,
        )
      })
      .join('\n')

    declarationSections.push(renderDeclarationSection(entry.exportedName, docs, code, propertyDocs))
  }

  const symbolSections = [
    ...declarationSections,
    ...followedImports.sections,
    ...followedImportedReExports.sections,
    ...followedReExports.sections,
  ]
  sections.push(...(context?.reverseSymbols ? symbolSections.toReversed() : symbolSections))

  return sections
}

function getRenderedExportedName(
  entry: DeclarationEntry,
  exportedNameOverrides: ReadonlyMap<string, string>,
) {
  const explicitName =
    exportedNameOverrides.get(entry.exportedName) ?? exportedNameOverrides.get(entry.localName)
  if (explicitName) return explicitName

  if (isMinifiedName(entry.exportedName) && !isMinifiedName(entry.localName)) {
    return entry.localName
  }

  return entry.exportedName
}

function isMinifiedName(name: string) {
  return /^[$A-Z_a-z]$/.test(name)
}

async function renderFollowedImportSections(
  ts: TypeScript,
  imports: ImportEntry[],
  importedNames: ReadonlySet<string>,
  context: RenderContext,
) {
  const followed = new Set<ImportEntry>()
  const sections: string[] = []

  for (const entry of imports) {
    const requestedSourceNames = getImportRequestedSourceNames(entry, importedNames)
    if (requestedSourceNames.length === 0) continue

    const targetFile = resolveModuleTarget(
      ts,
      context.inputFile,
      context.cwd,
      entry.moduleSpecifier,
    )
    if (!targetFile || context.visited.has(resolve(targetFile))) continue

    const overrides = getImportedNameOverrides(entry)
    const targetDeclaration = isDeclarationFile(targetFile)
      ? await readFile(targetFile, 'utf8')
      : compileDeclaration(ts, targetFile, context.cwd)
    const targetContext = {
      ...context,
      inputFile: targetFile,
      visited: new Set([...context.visited, resolve(targetFile)]),
    }

    sections.push(
      ...(await renderDeclarationBody(
        ts,
        targetDeclaration,
        requestedSourceNames,
        targetContext,
        overrides,
        false,
      )),
    )
    followed.add(entry)
  }

  return {
    followed,
    sections,
  }
}

async function renderFollowedImportedReExportSections(
  ts: TypeScript,
  entries: ImportedReExportEntry[],
  allEntries: ImportedReExportEntry[],
  context: RenderContext,
) {
  const followed = new Set<ImportedReExportEntry>()
  const sections: string[] = []
  const groups = new Map<ImportEntry, ImportedReExportEntry[]>()

  for (const entry of entries) {
    const group = groups.get(entry.importEntry)
    if (group) {
      group.push(entry)
    } else {
      groups.set(entry.importEntry, [entry])
    }
  }

  for (const [importEntry, group] of groups) {
    const targetFile = resolveModuleTarget(
      ts,
      context.inputFile,
      context.cwd,
      importEntry.moduleSpecifier,
    )
    if (!targetFile || context.visited.has(resolve(targetFile))) continue

    const overrides = new Map(
      allEntries
        .filter((entry) => entry.importEntry === importEntry)
        .map((entry) => [entry.sourceName, entry.exportedName]),
    )
    const targetDeclaration = isDeclarationFile(targetFile)
      ? await readFile(targetFile, 'utf8')
      : compileDeclaration(ts, targetFile, context.cwd)
    const targetContext = {
      ...context,
      inputFile: targetFile,
      visited: new Set([...context.visited, resolve(targetFile)]),
    }

    sections.push(
      ...(await renderDeclarationBody(
        ts,
        targetDeclaration,
        group.map((entry) => entry.sourceName),
        targetContext,
        overrides,
      )),
    )

    for (const entry of group) {
      followed.add(entry)
    }
  }

  return {
    followed,
    sections,
  }
}

async function renderFollowedReExportSections(
  ts: TypeScript,
  reExports: ReExportEntry[],
  requested: ReadonlySet<string>,
  context: RenderContext,
) {
  const followed = new Set<ReExportEntry>()
  const sections: string[] = []

  for (const entry of reExports) {
    if (isNamespaceReExport(ts, entry)) continue

    const targetFile = resolveModuleTarget(
      ts,
      context.inputFile,
      context.cwd,
      entry.moduleSpecifier,
    )
    if (!targetFile || context.visited.has(resolve(targetFile))) continue

    const requestedSourceNames = getReExportRequestedSourceNames(ts, entry, requested)
    const overrides = getReExportedNameOverrides(ts, entry)
    const targetDeclaration = isDeclarationFile(targetFile)
      ? await readFile(targetFile, 'utf8')
      : compileDeclaration(ts, targetFile, context.cwd)
    const targetContext = {
      ...context,
      inputFile: targetFile,
      visited: new Set([...context.visited, resolve(targetFile)]),
    }

    sections.push(
      ...(await renderDeclarationBody(
        ts,
        targetDeclaration,
        requestedSourceNames,
        targetContext,
        overrides,
      )),
    )
    followed.add(entry)
  }

  return {
    followed,
    sections,
  }
}

function groupDeclarationEntries(entries: DeclarationEntry[]) {
  const groups = new Map<string, DeclarationEntry[]>()

  for (const entry of entries) {
    const group = groups.get(entry.exportedName)
    if (group) {
      group.push(entry)
    } else {
      groups.set(entry.exportedName, [entry])
    }
  }

  return [...groups.values()]
}

function renderDeclarationCode(
  ts: TypeScript,
  entry: DeclarationEntry,
  nameOverrides: ReadonlyMap<string, string> = new Map(),
  renderExportModifier = true,
  edits: readonly CodeEdit[] = [],
) {
  const replacements = new Map(nameOverrides)

  if (
    entry.isExported &&
    entry.exportedName !== entry.localName &&
    entry.exportedName !== 'default'
  ) {
    replacements.set(entry.localName, entry.exportedName)
  }

  let code = applyCodeEdits(entry.code, [
    ...edits,
    ...(replacements.size > 0 ? collectIdentifierReplacementEdits(ts, entry, replacements) : []),
  ])

  code = stripDeclareModifier(code)

  if (!renderExportModifier) return stripExportModifier(code)
  if (!entry.isExported) return code
  if (entry.exportedName === 'default') return renderDefaultDeclarationCode(ts, entry, code)

  return ensureExportModifier(code)
}

function collectIdentifierReplacementEdits(
  ts: TypeScript,
  entry: DeclarationEntry,
  replacements: ReadonlyMap<string, string>,
) {
  const sourceFile = entry.statement.getSourceFile()
  const statementStart = entry.statement.getStart(sourceFile)
  const typeParameters = collectStatementTypeParameterNames(ts, entry.statement)
  return collectIdentifiers(ts, entry.statement)
    .map((identifier) => {
      if (typeParameters.has(identifier.text)) return

      const replacement = replacements.get(identifier.text)
      if (!replacement) return

      return {
        end: identifier.end - statementStart,
        replacement,
        start: identifier.getStart(sourceFile) - statementStart,
      }
    })
    .filter((edit): edit is NonNullable<typeof edit> => Boolean(edit))
}

function applyCodeEdits(code: string, edits: readonly CodeEdit[]) {
  let edited = code
  for (const edit of [...edits].sort((left, right) => right.start - left.start)) {
    edited = `${edited.slice(0, edit.start)}${edit.replacement}${edited.slice(edit.end)}`
  }

  return edited
}

function collectPropertyDocs(ts: TypeScript, declaration: string, statement: Statement) {
  return collectDocumentedPropertyMembers(ts, declaration, statement).map(({ comment, name }) => ({
    docs: renderTsDoc(parseTsDoc(comment.raw)),
    name,
  }))
}

function collectPropertyDocCommentEdits(ts: TypeScript, declaration: string, statement: Statement) {
  const sourceFile = statement.getSourceFile()
  const statementStart = statement.getStart(sourceFile)

  return collectDocumentedPropertyMembers(ts, declaration, statement).map(({ comment, member }) => {
    const leadingWhitespace = declaration.slice(member.getFullStart(), comment.start)

    return {
      end: member.getStart(sourceFile) - statementStart,
      replacement: leadingWhitespace,
      start: member.getFullStart() - statementStart,
    }
  })
}

function collectDocumentedPropertyMembers(
  ts: TypeScript,
  declaration: string,
  statement: Statement,
) {
  const sourceFile = statement.getSourceFile()
  const docs: {
    comment: { raw: string; start: number }
    member: Node
    name: string
  }[] = []

  function visit(node: Node) {
    if (ts.isInterfaceDeclaration(node) || ts.isTypeLiteralNode(node)) {
      for (const member of node.members) {
        if (!ts.isPropertySignature(member) && !ts.isMethodSignature(member)) continue

        const name = getPropertyDocName(ts, member.name, sourceFile)
        const comment = getLeadingTsDocComment(ts, declaration, member)
        if (!name || !comment) continue

        docs.push({ comment, member, name })
      }
    }

    ts.forEachChild(node, visit)
  }

  visit(statement)
  return docs
}

function getPropertyDocName(ts: TypeScript, name: Node, sourceFile: SourceFile) {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) {
    return name.text
  }

  return name.getText(sourceFile)
}

function collectStatementTypeParameterNames(ts: TypeScript, statement: Statement) {
  const names = new Set<string>()

  if (
    ts.isFunctionDeclaration(statement) ||
    ts.isClassDeclaration(statement) ||
    ts.isInterfaceDeclaration(statement) ||
    ts.isTypeAliasDeclaration(statement)
  ) {
    for (const typeParameter of statement.typeParameters ?? []) {
      names.add(typeParameter.name.text)
    }
  }

  return names
}

function stripDeclareModifier(code: string) {
  return code.replace(/^export\s+declare\s+/, 'export ').replace(/^declare\s+/, '')
}

function stripExportModifier(code: string) {
  return code.replace(/^export\s+default\s+/, '').replace(/^export\s+/, '')
}

function renderDefaultDeclarationCode(ts: TypeScript, entry: DeclarationEntry, code: string) {
  if (/^export\s+default\b/.test(code)) return code

  const withoutExport = code.replace(/^export\s+/, '')
  if (
    ts.isFunctionDeclaration(entry.statement) ||
    ts.isClassDeclaration(entry.statement) ||
    ts.isInterfaceDeclaration(entry.statement)
  ) {
    return `export default ${withoutExport}`
  }

  return `${withoutExport}\nexport default ${entry.localName};`
}

function ensureExportModifier(code: string) {
  return /^export\b/.test(code) ? code : `export ${code}`
}

function resolveModuleTarget(
  ts: TypeScript,
  inputFile: string,
  cwd: string,
  moduleSpecifier: string,
) {
  if (!moduleSpecifier.startsWith('.')) return undefined

  let options: CompilerOptions
  try {
    options = getCompilerOptions(ts, inputFile, cwd)
  } catch {
    options = {}
  }

  return ts.resolveModuleName(moduleSpecifier, inputFile, options, ts.sys).resolvedModule
    ?.resolvedFileName
}

function getImportRequestedSourceNames(entry: ImportEntry, importedNames: ReadonlySet<string>) {
  return [...entry.importedNameAliases]
    .filter(([localName]) => importedNames.has(localName))
    .map(([, sourceName]) => sourceName)
}

function getImportedNameOverrides(entry: ImportEntry) {
  const overrides = new Map<string, string>()

  for (const [localName, sourceName] of entry.importedNameAliases) {
    if (localName !== sourceName) {
      overrides.set(sourceName, localName)
    }
  }

  return overrides
}

function getReExportRequestedSourceNames(
  ts: TypeScript,
  entry: ReExportEntry,
  requested: ReadonlySet<string>,
) {
  if (entry.exportsAll) {
    return [...requested]
  }

  if (!ts.isExportDeclaration(entry.statement)) return []

  const clause = entry.statement.exportClause
  if (!clause || ts.isNamespaceExport(clause)) return []

  return clause.elements
    .filter((element) => requested.size === 0 || requested.has(element.name.text))
    .map((element) => element.propertyName?.text ?? element.name.text)
}

function getReExportedNameOverrides(ts: TypeScript, entry: ReExportEntry) {
  const overrides = new Map<string, string>()
  if (!ts.isExportDeclaration(entry.statement)) return overrides

  const clause = entry.statement.exportClause
  if (!clause || ts.isNamespaceExport(clause)) return overrides

  for (const element of clause.elements) {
    overrides.set(element.propertyName?.text ?? element.name.text, element.name.text)
  }

  return overrides
}

function isNamespaceReExport(ts: TypeScript, entry: ReExportEntry) {
  if (!ts.isExportDeclaration(entry.statement)) return false

  const clause = entry.statement.exportClause
  return clause ? ts.isNamespaceExport(clause) : false
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

function getCompilerOptions(ts: TypeScript, inputFile: string, cwd: string) {
  const configPath = findTsConfig(inputFile)
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
  const importedReExports: ImportedReExportEntry[] = []
  const imports: ImportEntry[] = []
  const reExports: ReExportEntry[] = []

  sourceFile.statements.forEach((statement, index) => {
    if (ts.isExportDeclaration(statement)) {
      if (statement.moduleSpecifier) {
        if (!ts.isStringLiteral(statement.moduleSpecifier)) return

        reExports.push({
          code: declaration.slice(statement.getStart(sourceFile), statement.end).trim(),
          exportedNames: collectExportedNames(ts, statement),
          exportsAll: !statement.exportClause,
          index,
          moduleSpecifier: statement.moduleSpecifier.text,
          statement,
        })
      }
      return
    }

    if (ts.isImportDeclaration(statement)) {
      if (!statement.moduleSpecifier || !ts.isStringLiteral(statement.moduleSpecifier)) return

      const importedNameAliases = collectImportedNameAliases(ts, statement)
      if (importedNameAliases.size > 0) {
        const importEntry = {
          code: declaration.slice(statement.getStart(sourceFile), statement.end).trim(),
          importedNameAliases,
          importedNames: new Set(importedNameAliases.keys()),
          index,
          moduleSpecifier: statement.moduleSpecifier.text,
          statement,
        }
        imports.push(importEntry)

        for (const [localName, sourceName] of importedNameAliases) {
          const exportedName = exportsByLocalName.get(localName)
          if (!exportedName) continue

          importedReExports.push({
            exportedName,
            importEntry,
            sourceName,
          })
        }
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
    importedReExports,
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

function collectImportedNameAliases(ts: TypeScript, statement: Statement) {
  const names = new Map<string, string>()
  if (!ts.isImportDeclaration(statement)) return names

  const clause = statement.importClause
  if (!clause) return names

  if (clause.name) {
    names.set(clause.name.text, 'default')
  }

  const bindings = clause.namedBindings
  if (!bindings) return names

  if (ts.isNamespaceImport(bindings)) {
    return names
  }

  for (const element of bindings.elements) {
    names.set(element.name.text, element.propertyName?.text ?? element.name.text)
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

function selectImportedReExportEntries(
  importedReExports: ImportedReExportEntry[],
  requested: ReadonlySet<string>,
) {
  if (requested.size === 0) return importedReExports

  return importedReExports.filter((entry) => requested.has(entry.exportedName))
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

function getLeadingTsDoc(ts: TypeScript, text: string, node: Node) {
  return getLeadingTsDocComment(ts, text, node)?.raw
}

function getLeadingTsDocComment(ts: TypeScript, text: string, node: Node) {
  const comments = ts.getLeadingCommentRanges(text, node.getFullStart()) ?? []

  for (const comment of comments.toReversed()) {
    const raw = text.slice(comment.pos, comment.end)
    if (raw.startsWith('/**')) {
      return {
        raw,
        start: comment.pos,
      }
    }
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

function renderDeclarationSection(
  name: string,
  docs: string,
  code: string,
  propertyDocs: readonly PropertyDoc[] = [],
) {
  return [`## \`${name}\``, docs, renderCodeBlock(code), renderPropertyDocs(propertyDocs)]
    .filter(Boolean)
    .join('\n\n')
}

function renderPropertyDocs(propertyDocs: readonly PropertyDoc[]) {
  if (propertyDocs.length === 0) return ''

  const properties = propertyDocs
    .filter((propertyDoc) => propertyDoc.docs)
    .map((propertyDoc) => {
      const indentedDocs = propertyDoc.docs
        .split('\n')
        .map((line) => `  ${line}`)
        .join('\n')

      return `- \`${propertyDoc.name}\`\n${indentedDocs}`
    })

  if (properties.length === 0) return ''

  return `**Properties**\n\n${properties.join('\n\n')}`
}

function renderCodeBlock(code: string) {
  return `\`\`\`ts\n${code}\n\`\`\``
}

async function getCacheFile(
  inputFile: string,
  cwd: string,
  symbols: readonly string[],
  heading: string,
  reverseSymbols: boolean,
) {
  const source = await readFile(inputFile, 'utf8')
  const configPath = findTsConfig(inputFile)
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
    .update('\0')
    .update(JSON.stringify({ reverseSymbols }))
    .digest('hex')

  return join(tmpdir(), 'exports-md', `${hash}.json`)
}

function findTsConfig(inputFile: string) {
  let dir = dirname(inputFile)

  while (true) {
    const candidate = join(dir, 'tsconfig.json')
    if (isFile(candidate)) return candidate

    const parent = dirname(dir)
    if (dir === parent) return undefined
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

function cliInputsAndSymbols() {
  return {
    helpTopics() {
      return [
        {
          category: 'arguments',
          defaults: [],
          description: 'Inputs to document, followed by optional export symbols after --.',
          usage: '[...input] -- [...symbol]',
        },
      ]
    },
    register() {},
    async parse(context: CliParseContext) {
      const values: string[] = []

      for (const node of context.nodes) {
        if (context.visitedNodes.has(node)) {
          continue
        }

        if (node.type === 'forcePositional') {
          values.push('--')
          context.visitedNodes.add(node)
          continue
        }

        if (node.type === 'positionalArgument') {
          values.push(node.raw)
          context.visitedNodes.add(node)
        }
      }

      try {
        return {
          _tag: 'ok' as const,
          value: splitCliInputsAndSymbols(values),
        }
      } catch (error) {
        return {
          _tag: 'error' as const,
          error: {
            errors: [
              {
                message: error instanceof Error ? error.message : String(error),
                nodes: [],
              },
            ],
          },
        }
      }
    },
  }
}

function splitCliInputsAndSymbols(values: readonly string[]): CliInputsAndSymbols {
  const delimiterIndex = values.indexOf('--')
  const inputs = delimiterIndex === -1 ? [...values] : values.slice(0, delimiterIndex)
  const symbols = delimiterIndex === -1 ? [] : values.slice(delimiterIndex + 1)

  if (inputs.length === 0) {
    throw new Error('At least one input is required.')
  }

  return {
    inputs,
    symbols,
  }
}

const app = command({
  name: 'exports-md',
  description: 'Print Markdown docs for TypeScript module or package exports.',
  args: {
    outDir: option({
      type: optional(string),
      long: 'outDir',
      short: 'o',
      description: 'Write package entry Markdown files to this directory.',
    }),
    follow: flag({
      long: 'follow',
      short: 'f',
      description: 'Render relative imported and re-exported declarations.',
    }),
    followImports: flag({
      long: 'followImports',
      short: 'i',
      description: 'Render relative imported declarations instead of only printing import lines.',
    }),
    followReExports: flag({
      long: 'followReExports',
      short: 'e',
      description:
        'Render relative re-exported declarations instead of only printing export-from lines.',
    }),
    reverseSymbols: flag({
      long: 'reverseSymbols',
      short: 'r',
      description: 'Print rendered symbol sections in reverse order.',
    }),
    propertyDocs: option({
      type: optional(oneOf(propertyDocModes)),
      long: 'property-docs',
      description: 'Render property TSDoc comments inline or as a list below declaration code.',
    }),
    query: cliInputsAndSymbols(),
  },
  async handler({
    follow,
    followImports,
    followReExports,
    outDir,
    propertyDocs,
    query,
    reverseSymbols,
  }) {
    const result = await generateMarkdownForInputs(query.inputs, {
      followImports: follow || followImports || undefined,
      followReExports: follow || followReExports || undefined,
      outDir,
      propertyDocs,
      reverseSymbols,
      symbols: query.symbols,
    })
    if (!outDir) {
      process.stdout.write(result.markdown)
    }
  },
})

if (import.meta.main) {
  await run(binary(app), process.argv)
}
