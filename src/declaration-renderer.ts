import { readFile } from 'node:fs/promises'
import { relative, resolve } from 'node:path'
import type { Node, SourceFile, Statement } from 'typescript'
import { isDeclarationFile } from './files.ts'
import {
  collectIdentifiers,
  collectReferencedImportedNames,
  getImportRequestedSourceNames,
  getReExportRequestedSourceNames,
  getReExportedNameOverrides,
  getStatementName,
  indexDeclarationFile,
  isNamespaceReExport,
  selectDeclarationEntries,
  selectImportedReExportEntries,
  selectReExportEntries,
} from './declaration-model.ts'
import { compileDeclaration, resolveModuleTarget } from './typescript.ts'
import {
  getLeadingTsDoc as getTsDoc,
  getLeadingTsDocComment as getTsDocComment,
  parseTsDoc,
  renderTsDoc,
  renderTsDocMarkdown,
} from './tsdoc.ts'
import type {
  CodeEdit,
  DeclarationEntry,
  ImportEntry,
  ImportedReExportEntry,
  PropertyDoc,
  ReExportEntry,
  RenderContext,
  TypeScript,
} from './internal-types.ts'
import type { GitHubOptions } from './types.ts'

export async function renderDeclarationMarkdown(
  ts: TypeScript,
  declaration: string,
  heading: string,
  requestedSymbols: readonly string[] = [],
  context?: RenderContext,
) {
  const sections = [`# ${heading}`]
  const body = await renderDeclarationBody(ts, declaration, requestedSymbols, context)
  sections.push(...body.references, ...body.symbols)

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
    : { followed: new Set<ReExportEntry>(), references: [], symbols: [] }
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
    : { followed: new Set<ImportedReExportEntry>(), references: [], symbols: [] }
  const importedNames = collectReferencedImportedNames(ts, included, imports, declarations)
  const includedImports = imports.filter((entry) =>
    [...entry.importedNames].some((name) => importedNames.has(name)),
  )
  const followedImports = context?.followImports
    ? await renderFollowedImportSections(
        ts,
        includedImports,
        importedNames,
        importedReExports,
        context,
      )
    : { followed: new Set<ImportEntry>(), references: [], symbols: [] }
  const unresolvedImports = context?.followImports
    ? includedImports.filter((entry) => !followedImports.followed.has(entry))
    : includedImports
  const referenceEntries = [...unresolvedImports, ...unresolvedReExports].sort(
    (left, right) => left.index - right.index,
  )
  // References stay separate while followed declarations are sorted so nested imports remain first.
  const references: string[] = []

  if (referenceEntries.length > 0) {
    references.push(renderCodeBlock(referenceEntries.map((entry) => entry.code).join('\n')))
  }

  const includedWithOverrides = included.map((entry) => ({
    ...entry,
    exportedName: getRenderedExportedName(entry, exportedNameOverrides),
  }))

  const declarationSections = renderDeclarationSections(
    ts,
    declaration,
    includedWithOverrides,
    exportedNameOverrides,
    renderExportModifiers,
    context,
  )
  const followedSections = [
    ...followedImports.symbols,
    ...followedImportedReExports.symbols,
    ...followedReExports.symbols,
  ]
  references.push(
    ...followedImports.references,
    ...followedImportedReExports.references,
    ...followedReExports.references,
  )

  if (context?.groupBySyntax) {
    const groupedSections = mergeGroupedDeclarationSections(
      context.reverseSymbols
        ? [...followedSections.toReversed(), ...declarationSections]
        : [...declarationSections, ...followedSections],
      {
        reverseSymbols: context.reverseSymbols,
        sortByName: context.sortByName,
      },
    )
    return { references, symbols: groupedSections }
  }

  const symbolSections = [...declarationSections, ...followedSections]
  return {
    references,
    symbols: context?.reverseSymbols ? symbolSections.toReversed() : symbolSections,
  }
}

function renderDeclarationSections(
  ts: TypeScript,
  declaration: string,
  entries: DeclarationEntry[],
  exportedNameOverrides: ReadonlyMap<string, string>,
  renderExportModifiers: boolean,
  context?: RenderContext,
) {
  const groups = groupDeclarationEntries(ts, entries, {
    groupBySyntax: context?.groupBySyntax,
    sortByName: context?.sortByName,
  })
  const renderedGroups = groups
    .map((entries) => ({
      entries,
      section: renderSymbolDeclarationSection(
        ts,
        declaration,
        entries,
        exportedNameOverrides,
        renderExportModifiers,
        context,
      ),
    }))
    .filter((group) => group.section)
  const symbolSections = renderedGroups.map((group) => group.section)

  if (!context?.groupBySyntax) return symbolSections

  const groupedSections = new Map<number, string[]>()
  const orderedGroups = context.reverseSymbols ? renderedGroups.toReversed() : renderedGroups

  for (const group of orderedGroups) {
    const sortOrder = getDeclarationEntrySortOrder(ts, group.entries[0]!)
    const sections = groupedSections.get(sortOrder)
    if (sections) {
      sections.push(group.section)
    } else {
      groupedSections.set(sortOrder, [group.section])
    }
  }

  return [...groupedSections].map(([sortOrder, sections]) =>
    [`## ${getDeclarationEntryGroupHeading(sortOrder)}`, ...sections].join('\n\n'),
  )
}

function mergeGroupedDeclarationSections(
  sections: string[],
  options: { reverseSymbols?: boolean; sortByName?: boolean } = {},
) {
  const merged = new Map<string, string[]>()
  const output: Array<{ heading?: string; section?: string }> = []

  for (const section of sections) {
    const match = /^## ([^\n]+)\n\n([\s\S]+)$/.exec(section)
    if (!match) {
      output.push({ section })
      continue
    }

    const [, heading, body] = match
    const symbolSections = splitGroupedSymbolSections(body)
    const bodies = merged.get(heading)
    if (bodies) {
      bodies.push(...symbolSections)
    } else {
      merged.set(heading, symbolSections)
      output.push({ heading })
    }
  }

  return output.map((entry) => {
    if (entry.section) return entry.section

    let sections = merged.get(entry.heading!)!
    if (options.sortByName) {
      sections = sections.toSorted((left, right) =>
        compareSymbolNames(getGroupedSymbolName(left), getGroupedSymbolName(right)),
      )
      if (options.reverseSymbols) sections = sections.toReversed()
    }

    return [`## ${entry.heading}`, ...sections].join('\n\n')
  })
}

function splitGroupedSymbolSections(body: string) {
  return body.split(/\n\n(?=### `)/)
}

function getGroupedSymbolName(section: string) {
  return /^### `([^`]+)`/.exec(section)?.[1] ?? ''
}

function renderSymbolDeclarationSection(
  ts: TypeScript,
  declaration: string,
  entries: DeclarationEntry[],
  exportedNameOverrides: ReadonlyMap<string, string>,
  renderExportModifiers: boolean,
  context?: RenderContext,
) {
  const entry = entries[0]!
  const { statement } = entry
  const localName = getStatementName(ts, statement)
  if (!localName) return ''

  const documentedEntry =
    entries.find((entry) => getTsDoc(ts, declaration, entry.statement)) ?? entry
  const comment = getTsDoc(ts, declaration, documentedEntry.statement)
  const docs = comment ? renderTsDoc(parseTsDoc(comment)) : { body: '', tags: '' }
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

  return renderDeclarationSection(entry.exportedName, docs, code, propertyDocs, context?.github, {
    headingLevel: context?.groupBySyntax ? 3 : 2,
  })
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
  importedReExports: readonly ImportedReExportEntry[],
  context: RenderContext,
) {
  const followed = new Set<ImportEntry>()

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

    const exportedSourceNames = new Set(
      importedReExports
        .filter((reExport) => reExport.importEntry === entry)
        .map((reExport) => reExport.sourceName),
    )
    const omittedSourceNames = new Set(
      requestedSourceNames.filter((sourceName) => !exportedSourceNames.has(sourceName)),
    )

    if (isDeclarationFile(targetFile)) {
      for (const [localName, sourceName] of entry.importedNameAliases) {
        if (!importedNames.has(localName) || !omittedSourceNames.has(sourceName)) continue

        context.warnings.push(
          `Imported symbol "${localName}" from "${entry.moduleSpecifier}" is referenced by the public API of ${relative(
            context.cwd,
            context.inputFile,
          )} but is not exported; it was omitted from the rendered Markdown.`,
        )
      }
    }

    followed.add(entry)
  }

  return {
    followed,
    references: [] as string[],
    symbols: [] as string[],
  }
}

async function renderFollowedImportedReExportSections(
  ts: TypeScript,
  entries: ImportedReExportEntry[],
  allEntries: ImportedReExportEntry[],
  context: RenderContext,
) {
  const followed = new Set<ImportedReExportEntry>()
  const references: string[] = []
  const symbols: string[] = []
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
      : await compileDeclaration(ts, targetFile, context.cwd)
    const targetContext = {
      ...context,
      inputFile: targetFile,
      visited: new Set([...context.visited, resolve(targetFile)]),
    }

    const body = await renderDeclarationBody(
      ts,
      targetDeclaration,
      group.map((entry) => entry.sourceName),
      targetContext,
      overrides,
    )
    references.push(...body.references)
    symbols.push(...body.symbols)

    for (const entry of group) {
      followed.add(entry)
    }
  }

  return {
    followed,
    references,
    symbols,
  }
}

async function renderFollowedReExportSections(
  ts: TypeScript,
  reExports: ReExportEntry[],
  requested: ReadonlySet<string>,
  context: RenderContext,
) {
  const followed = new Set<ReExportEntry>()
  const references: string[] = []
  const symbols: string[] = []

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
      : await compileDeclaration(ts, targetFile, context.cwd)
    const targetContext = {
      ...context,
      inputFile: targetFile,
      visited: new Set([...context.visited, resolve(targetFile)]),
    }

    const body = await renderDeclarationBody(
      ts,
      targetDeclaration,
      requestedSourceNames,
      targetContext,
      overrides,
    )
    references.push(...body.references)
    symbols.push(...body.symbols)
    followed.add(entry)
  }

  return {
    followed,
    references,
    symbols,
  }
}

function groupDeclarationEntries(
  ts: TypeScript,
  entries: DeclarationEntry[],
  options: { groupBySyntax?: boolean; sortByName?: boolean } = {},
) {
  const groups = new Map<string, DeclarationEntry[]>()

  for (const entry of entries) {
    const group = groups.get(entry.exportedName)
    if (group) {
      group.push(entry)
    } else {
      groups.set(entry.exportedName, [entry])
    }
  }

  const grouped = [...groups.values()]
  if (!options.groupBySyntax && !options.sortByName) return grouped

  return grouped.sort(
    (left, right) =>
      (options.groupBySyntax
        ? getDeclarationEntrySortOrder(ts, left[0]!) - getDeclarationEntrySortOrder(ts, right[0]!)
        : 0) ||
      (options.sortByName
        ? compareSymbolNames(left[0]!.exportedName, right[0]!.exportedName)
        : 0) ||
      left[0]!.index - right[0]!.index,
  )
}

function getDeclarationEntrySortOrder(ts: TypeScript, entry: DeclarationEntry) {
  const { statement } = entry

  if (ts.isFunctionDeclaration(statement)) return 0
  if (ts.isClassDeclaration(statement)) return 1
  if (ts.isVariableStatement(statement) && isConstDeclaration(ts, statement)) return 2
  if (ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement)) return 4

  return 3
}

function getDeclarationEntryGroupHeading(sortOrder: number) {
  if (sortOrder === 0) return 'Functions'
  if (sortOrder === 1) return 'Classes'
  if (sortOrder === 2) return 'Constants'
  if (sortOrder === 4) return 'Types'

  return 'Other Exports'
}

function isConstDeclaration(ts: TypeScript, statement: Statement) {
  return (
    ts.isVariableStatement(statement) &&
    (ts.getCombinedNodeFlags(statement.declarationList) & ts.NodeFlags.Const) !== 0
  )
}

function compareSymbolNames(left: string, right: string) {
  return (
    getSymbolNameSortBucket(left) - getSymbolNameSortBucket(right) ||
    left.localeCompare(right, 'en', { caseFirst: 'lower', sensitivity: 'variant' })
  )
}

function getSymbolNameSortBucket(name: string) {
  if (isAllCapsSymbolName(name)) return 2

  const firstLetter = /[A-Za-z]/.exec(name)?.[0]
  return firstLetter && firstLetter === firstLetter.toLowerCase() ? 0 : 1
}

function isAllCapsSymbolName(name: string) {
  const normalized = name.replace(/[_$]/g, '')
  return /[A-Za-z]/.test(normalized) && normalized === normalized.toUpperCase()
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
    docs: renderTsDocMarkdown(parseTsDoc(comment.raw)),
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
        const comment = getTsDocComment(ts, declaration, member)
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

function renderDeclarationSection(
  name: string,
  docs: { body: string; tags: string },
  code: string,
  propertyDocs: readonly PropertyDoc[] = [],
  github?: GitHubOptions,
  options: { headingLevel?: 2 | 3 } = {},
) {
  const headingMarker = '#'.repeat(options.headingLevel ?? 2)

  return [
    `${headingMarker} \`${name}\``,
    docs.body,
    renderCodeBlock(code),
    docs.tags,
    renderPropertyDocs(propertyDocs),
    renderGitHubSearchLink(name, github),
  ]
    .filter(Boolean)
    .join('\n\n')
}

function renderGitHubSearchLink(name: string, github?: GitHubOptions) {
  if (!github?.searchLinks || !github.repository) return ''

  const query = `repo%3A${github.repository}%20${encodeURIComponent(name)}`
  return `[<sup>🔍 **${name}** on GitHub</sup>](https://github.com/search?q=${query}&type=code)`
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
