import type { Identifier, SourceFile, Statement } from 'typescript'
import type {
  DeclarationEntry,
  ImportedReExportEntry,
  ImportEntry,
  ReExportEntry,
  TypeScript,
} from './internal-types.ts'

export function collectExports(ts: TypeScript, sourceFile: SourceFile) {
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

export function indexDeclarationFile(ts: TypeScript, declaration: string, sourceFile: SourceFile) {
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

export function selectDeclarationEntries(
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

export function selectReExportEntries(reExports: ReExportEntry[], requested: ReadonlySet<string>) {
  if (requested.size === 0) return reExports

  return reExports.filter(
    (entry) =>
      entry.exportsAll ||
      [...entry.exportedNames].some((exportedName) => requested.has(exportedName)),
  )
}

export function selectImportedReExportEntries(
  importedReExports: ImportedReExportEntry[],
  requested: ReadonlySet<string>,
) {
  if (requested.size === 0) return importedReExports

  return importedReExports.filter((entry) => requested.has(entry.exportedName))
}

export function collectReferencedImportedNames(
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

export function collectIdentifiers(ts: TypeScript, statement: Statement) {
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

export function getStatementName(ts: TypeScript, statement: Statement) {
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

export function hasExportModifier(ts: TypeScript, statement: Statement) {
  return hasModifier(ts, statement, ts.SyntaxKind.ExportKeyword)
}

function hasDefaultModifier(ts: TypeScript, statement: Statement) {
  return hasModifier(ts, statement, ts.SyntaxKind.DefaultKeyword)
}

function hasModifier(ts: TypeScript, statement: Statement, kind: number) {
  if (!ts.canHaveModifiers(statement)) return false
  return ts.getModifiers(statement)?.some((modifier) => modifier.kind === kind) ?? false
}

export function getImportRequestedSourceNames(
  entry: ImportEntry,
  importedNames: ReadonlySet<string>,
) {
  return [...entry.importedNameAliases]
    .filter(([localName]) => importedNames.has(localName))
    .map(([, sourceName]) => sourceName)
}

export function getReExportRequestedSourceNames(
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

export function getReExportedNameOverrides(ts: TypeScript, entry: ReExportEntry) {
  const overrides = new Map<string, string>()
  if (!ts.isExportDeclaration(entry.statement)) return overrides

  const clause = entry.statement.exportClause
  if (!clause || ts.isNamespaceExport(clause)) return overrides

  for (const element of clause.elements) {
    overrides.set(element.propertyName?.text ?? element.name.text, element.name.text)
  }

  return overrides
}

export function isNamespaceReExport(ts: TypeScript, entry: ReExportEntry) {
  if (!ts.isExportDeclaration(entry.statement)) return false

  const clause = entry.statement.exportClause
  return clause ? ts.isNamespaceExport(clause) : false
}
