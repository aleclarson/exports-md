import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import {
  getPackageEntryHeading,
  getPackageName,
  isNpmPackageSpec,
  readPackageEntryPoints,
  readPackageJson,
  withNpmPackage,
  writePackageMarkdownFiles,
} from './package-input.ts'
import { isDeclarationFile, isDirectory, isFile, isPackageJson } from './files.ts'
import { indexDeclarationFile } from './declaration-model.ts'
import { renderDeclarationMarkdown } from './declaration-renderer.ts'
import {
  assertTypeScriptModule,
  compileDeclaration,
  findNearestTypescript as findNearestTypescriptService,
  findTsConfig,
  loadWorkspaceTypescript,
} from './typescript.ts'
import type {
  GeneratedMarkdown,
  GenerateMarkdownOptions,
  GitHubOptions,
  PropertyDocMode,
} from './types.ts'
import type { CachedMarkdown, PackageMarkdownEntry, TypeScript } from './internal-types.ts'

const cacheVersion = 8
const packageVersion = '0.0.0'

export async function generateMarkdownForModule(
  modulePath: string,
  options: GenerateMarkdownOptions = {},
): Promise<GeneratedMarkdown> {
  return generateMarkdownForInput(modulePath, options)
}

export function findNearestTypescript(startDir = process.cwd()) {
  return findNearestTypescriptService(startDir)
}

export async function generateMarkdownForInputs(
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
    warnings: includedEntries.flatMap((entry) => entry.warnings),
  }
}

async function generateMarkdownForInput(
  modulePath: string,
  options: GenerateMarkdownOptions = {},
  allowMissingSymbols = false,
): Promise<GeneratedMarkdown & { foundSymbols: Set<string> }> {
  const cwd = resolve(options.cwd ?? process.cwd())
  const inputPath = resolve(cwd, modulePath)

  if (!isFile(inputPath) && !isDirectory(inputPath) && isNpmPackageSpec(modulePath)) {
    return withNpmPackage(modulePath, cwd, async (packageJsonFile) => {
      const result = await generateMarkdownForInput(packageJsonFile, options, allowMissingSymbols)

      // The extracted path is temporary, so expose the stable input the caller provided.
      return { ...result, inputFile: modulePath }
    })
  }

  const inputFile = isDirectory(inputPath) ? join(inputPath, 'package.json') : inputPath
  const symbols = normalizeSymbols(options.symbols ?? [])
  const followImports = options.followImports ?? isPackageJson(inputFile)
  const followReExports = options.followReExports ?? isPackageJson(inputFile)
  const github = normalizeGitHubOptions(options.github)
  const propertyDocs = options.propertyDocs ?? 'inline'
  const reverseSymbols = options.reverseSymbols ?? false
  const groupBySyntax = options.groupBySyntax ?? false
  const sortByName = options.sortByName ?? false

  if (inputFile !== inputPath && !isFile(inputFile)) {
    throw new Error(`Package manifest not found in directory: ${inputFile}`)
  }

  if (isPackageJson(inputFile)) {
    return generateMarkdownForPackage(
      inputFile,
      cwd,
      symbols,
      followImports,
      followReExports,
      github,
      propertyDocs,
      reverseSymbols,
      groupBySyntax,
      sortByName,
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
    github,
    propertyDocs,
    reverseSymbols,
    groupBySyntax,
    sortByName,
    undefined,
    allowMissingSymbols,
  )
}

async function generateMarkdownForPackage(
  packageJsonFile: string,
  cwd: string,
  symbols: readonly string[],
  followImports: boolean,
  followReExports: boolean,
  github: GitHubOptions | undefined,
  propertyDocs: PropertyDocMode,
  reverseSymbols: boolean,
  groupBySyntax: boolean,
  sortByName: boolean,
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
          github,
          propertyDocs,
          reverseSymbols,
          groupBySyntax,
          sortByName,
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
    warnings: includedEntries.flatMap((entry) => entry.warnings),
  }
}

async function generateMarkdownForDeclarationFile(
  inputFile: string,
  cwd: string,
  symbols: readonly string[],
  followImports: boolean,
  followReExports: boolean,
  github: GitHubOptions | undefined,
  propertyDocs: PropertyDocMode,
  reverseSymbols: boolean,
  groupBySyntax: boolean,
  sortByName: boolean,
  heading = basename(inputFile),
  allowMissingSymbols = false,
): Promise<GeneratedMarkdown & { foundSymbols: Set<string> }> {
  assertTypeScriptModule(inputFile)
  const listPropertyDocs = propertyDocs === 'list'
  const cacheFile =
    listPropertyDocs || allowMissingSymbols || followImports || followReExports
      ? undefined
      : await getCacheFile(
          inputFile,
          cwd,
          symbols,
          heading,
          github,
          reverseSymbols,
          groupBySyntax,
          sortByName,
        )
  const cached = cacheFile ? await readCache(cacheFile) : undefined
  if (cached) {
    return {
      declaration: cached.declaration,
      foundSymbols: new Set(symbols),
      fromCache: true,
      inputFile,
      markdown: cached.markdown,
      warnings: [],
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
  const warnings: string[] = []
  const markdown =
    allowMissingSymbols && symbols.length > 0 && foundSymbols.size === 0
      ? `# ${heading}\n`
      : await renderDeclarationMarkdown(ts, declaration, heading, renderSymbols, {
          cwd,
          followImports,
          followReExports,
          github,
          inputFile,
          propertyDocs,
          reverseSymbols,
          groupBySyntax,
          sortByName,
          visited: new Set([resolve(inputFile)]),
          warnings,
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
    warnings,
  }
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

async function getCacheFile(
  inputFile: string,
  cwd: string,
  symbols: readonly string[],
  heading: string,
  github: GitHubOptions | undefined,
  reverseSymbols: boolean,
  groupBySyntax: boolean,
  sortByName: boolean,
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
    .update(JSON.stringify({ github, reverseSymbols, groupBySyntax, sortByName }))
    .digest('hex')

  return join(tmpdir(), 'exports-md', `${hash}.json`)
}

function normalizeGitHubOptions(github: GitHubOptions | undefined) {
  if (!github?.searchLinks) return github
  if (!github.repository) {
    throw new Error('github.repository is required when github.searchLinks is enabled.')
  }
  return github
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
