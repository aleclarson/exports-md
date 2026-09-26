import { existsSync } from 'node:fs'
import { execFile as execFileCallback } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import type { CompilerOptions, Diagnostic } from 'typescript'
import { isDirectory, isFile } from './files.ts'
import type { TypeScript } from './internal-types.ts'

const execFile = promisify(execFileCallback)

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

export function loadWorkspaceTypescript(cwd = process.cwd()): TypeScript {
  const typescriptDir = findNearestTypescript(cwd)
  const require = createRequire(join(typescriptDir, 'package.json'))
  return require('typescript') as TypeScript
}

export async function compileDeclaration(
  ts: TypeScript,
  inputFile: string,
  cwd = process.cwd(),
  platformModuleSuffix?: string,
  projectConfigPath?: string,
): Promise<string> {
  const effectivePlatformSuffix = getPlatformModuleSuffix(inputFile) ?? platformModuleSuffix
  const tsrxTsc = findTsrxTsc(inputFile) ?? findTsrxTsc(cwd)
  if (extname(inputFile) === '.tsrx' || tsrxTsc) {
    if (!tsrxTsc) {
      throw new Error(`Compiling ${inputFile} requires @tsrx/typescript-plugin in the workspace`)
    }
    return compileWithTsrxTsc(
      ts,
      inputFile,
      cwd,
      tsrxTsc,
      effectivePlatformSuffix,
      projectConfigPath,
    )
  }

  const options = getCompilerOptions(ts, inputFile, cwd, effectivePlatformSuffix, projectConfigPath)
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

export function resolveModuleTarget(
  ts: TypeScript,
  inputFile: string,
  cwd: string,
  moduleSpecifier: string,
  platformModuleSuffix?: string,
  projectConfigPath?: string,
) {
  if (!moduleSpecifier.startsWith('.')) return undefined

  let options: CompilerOptions
  try {
    options = getCompilerOptions(ts, inputFile, cwd, platformModuleSuffix, projectConfigPath)
  } catch {
    options = {}
  }

  let resolvedFileName = ts.resolveModuleName(moduleSpecifier, inputFile, options, ts.sys)
    .resolvedModule?.resolvedFileName
  if (!resolvedFileName && moduleSpecifier.startsWith('.')) {
    const candidate = resolve(dirname(inputFile), moduleSpecifier)
    const suffixCandidates = platformModuleSuffix ? [`${candidate}${platformModuleSuffix}.ts`] : []
    const candidates = candidate.endsWith('.tsrx')
      ? [candidate]
      : [...suffixCandidates, `${candidate}.tsrx`, `${candidate}.ts`, join(candidate, 'index.tsrx')]
    resolvedFileName = candidates.find((path) => isFile(path))
  }
  if (!resolvedFileName || isNodeModulesPath(resolvedFileName)) return undefined

  return resolvedFileName
}

export function findTsConfig(inputFile: string) {
  let dir = dirname(inputFile)

  while (true) {
    const candidate = join(dir, 'tsconfig.json')
    if (isFile(candidate)) return candidate

    const parent = dirname(dir)
    if (dir === parent) return undefined
    dir = parent
  }
}

export function assertTypeScriptModule(inputFile: string) {
  if (!isFile(inputFile)) {
    throw new Error(`Module not found: ${inputFile}`)
  }

  const extension = extname(inputFile)
  if (!['.ts', '.mts', '.cts', '.tsx', '.tsrx'].includes(extension)) {
    throw new Error(`Expected a TypeScript module, got ${inputFile}`)
  }
}

function getCompilerOptions(
  ts: TypeScript,
  inputFile: string,
  cwd: string,
  platformModuleSuffix?: string,
  projectConfigPath?: string,
) {
  const configPath = projectConfigPath ?? findTsrxConfig(ts, inputFile, platformModuleSuffix)
  const baseOptions = configPath ? readConfigOptions(ts, configPath, cwd) : {}

  return {
    ...baseOptions,
    target: baseOptions.target ?? ts.ScriptTarget.ES2022,
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

function findTsrxTsc(startDir: string) {
  let dir = resolve(startDir)

  while (true) {
    const candidate = join(dir, 'node_modules', '@tsrx', 'typescript-plugin', 'dist', 'tsc.js')
    if (isFile(candidate)) return candidate

    const parent = dirname(dir)
    if (parent === dir) return undefined
    dir = parent
  }
}

export function findTsrxConfig(ts: TypeScript, inputFile: string, platformModuleSuffix?: string) {
  const directConfig = findTsConfig(inputFile)
  if (directConfig) return directConfig

  const baseConfig = findTsrxBaseConfig(inputFile)
  if (!baseConfig) return undefined

  const workspaceRoot = dirname(baseConfig)
  const candidates = ts.sys.readDirectory(
    workspaceRoot,
    ['.json'],
    ['**/node_modules/**', '**/.git/**'],
    ['**/tsconfig.json'],
  )
  let bestConfig: string | undefined
  let bestScore = 0

  for (const configPath of candidates) {
    const config = ts.readConfigFile(configPath, ts.sys.readFile)
    if (!config.config) continue
    const parsed = ts.parseJsonConfigFileContent(
      config.config,
      ts.sys,
      dirname(configPath),
      {},
      configPath,
    )
    if (!parsed.fileNames.some((file) => samePath(ts, file, inputFile))) continue

    const configuredSuffixes = parsed.options.moduleSuffixes as string[] | undefined
    const conditions = parsed.options.customConditions as string[] | undefined
    const expectedCondition = platformModuleSuffix?.slice(1)
    const score =
      expectedCondition &&
      platformModuleSuffix &&
      (configuredSuffixes?.includes(platformModuleSuffix) ||
        conditions?.includes(expectedCondition))
        ? 2
        : 1
    if (score > bestScore) {
      bestConfig = configPath
      bestScore = score
    }
  }

  return bestConfig ?? baseConfig
}

function compileWithTsrxTsc(
  ts: TypeScript,
  inputFile: string,
  cwd: string,
  tscPath: string,
  platformModuleSuffix?: string,
  projectConfigPath?: string,
) {
  return compileWithTsrxTscAsync(
    ts,
    inputFile,
    cwd,
    tscPath,
    platformModuleSuffix,
    projectConfigPath,
  )
}

function compileWithTsrxTscAsync(
  ts: TypeScript,
  inputFile: string,
  cwd: string,
  tscPath: string,
  platformModuleSuffix?: string,
  projectConfigPath?: string,
) {
  return (async () => {
    const baseConfig = projectConfigPath ?? findTsrxConfig(ts, inputFile, platformModuleSuffix)
    const baseOptions = baseConfig ? readConfigOptions(ts, baseConfig, cwd) : {}
    const rawConfig = baseConfig ? ts.readConfigFile(baseConfig, ts.sys.readFile).config : {}
    const inheritedFiles = Array.isArray(rawConfig.files)
      ? rawConfig.files.map((file: string) => resolve(dirname(baseConfig!), file))
      : []
    // Keep the temporary config beside the project config so TSRX can resolve
    // compiler plugins and compiler packages from the workspace.
    const tempDir = await mkdtemp(join(baseConfig ? dirname(baseConfig) : cwd, '.exports-md-tsrx-'))
    const outputDir = join(tempDir, 'declarations')
    const configPath = join(tempDir, 'tsconfig.json')
    const effectivePlatformSuffix = getPlatformModuleSuffix(inputFile) ?? platformModuleSuffix
    const config = {
      ...(baseConfig ? { extends: baseConfig } : {}),
      files: [...inheritedFiles, resolve(inputFile)],
      include: [],
      compilerOptions: {
        declaration: true,
        declarationMap: false,
        emitDeclarationOnly: true,
        noEmit: false,
        noEmitOnError: false,
        outDir: outputDir,
        skipLibCheck: true,
        sourceMap: false,
        ...(baseOptions.target === undefined ? { target: 'ES2022' } : {}),
        ...(baseOptions.moduleSuffixes === undefined && effectivePlatformSuffix
          ? { moduleSuffixes: [effectivePlatformSuffix, ''] }
          : {}),
      },
    }

    try {
      await writeFile(configPath, JSON.stringify(config))
      try {
        await execFile(process.execPath, [tscPath, '--project', configPath, '--pretty', 'false'], {
          cwd,
          maxBuffer: 10 * 1024 * 1024,
        })
      } catch (error) {
        const detail = getCompilerFailureOutput(error)
        // Some projects contain a TypeScript facade and a same-named TSRX file.
        // TSRX strips its extension for declaration output, so only that unused
        // transitive declaration collides while the requested entry is emitted.
        if (!detail || detail.split('\n').some((line) => !/^error TS5056:/.test(line))) {
          throw new Error(detail || `Could not compile TSRX module ${inputFile}`)
        }
      }
      const declarations = await collectDeclarationFiles(outputDir)
      const extension = extname(inputFile)
      const declarationExtension =
        extension === '.mts' ? '.d.mts' : extension === '.cts' ? '.d.cts' : '.d.ts'
      const expectedName = `${inputFile.slice(0, -extension.length)}${declarationExtension}`
      const declarationName = basename(expectedName)
      const candidates = declarations.filter((file) => basename(file) === declarationName)
      if (candidates.length !== 1) {
        throw new Error(`TSRX compiler did not emit a declaration for ${inputFile}`)
      }
      return await readFile(candidates[0]!, 'utf8')
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  })()
}

function getCompilerFailureOutput(error: unknown) {
  if (!error || typeof error !== 'object') return ''
  const stderr = 'stderr' in error && typeof error.stderr === 'string' ? error.stderr.trim() : ''
  const stdout = 'stdout' in error && typeof error.stdout === 'string' ? error.stdout.trim() : ''
  return [stderr, stdout].filter(Boolean).join('\n')
}

function findTsrxBaseConfig(inputFile: string) {
  let dir = dirname(inputFile)

  while (true) {
    const candidate = join(dir, 'tsconfig.base.json')
    if (isFile(candidate)) return candidate

    const parent = dirname(dir)
    if (dir === parent) return undefined
    dir = parent
  }
}

export function getPlatformModuleSuffix(inputFile: string) {
  const match = basename(inputFile).match(/\.(web|native|ios|android)\.(?:ts|tsx|tsrx)$/)
  return match?.[1] ? `.${match[1]}` : undefined
}

async function collectDeclarationFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => [])
  const files: string[] = []
  for (const entry of entries) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) files.push(...(await collectDeclarationFiles(path)))
    else if (
      entry.isFile() &&
      (entry.name.endsWith('.d.ts') ||
        entry.name.endsWith('.d.mts') ||
        entry.name.endsWith('.d.cts'))
    ) {
      files.push(path)
    }
  }
  return files
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
  // This tool compiles an explicit input file, so a project include glob that
  // happens to match no files must not prevent reading its compiler options.
  throwOnDiagnostics(
    ts,
    parsed.errors.filter((diagnostic) => diagnostic.code !== 18003),
    cwd,
  )

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

function samePath(ts: TypeScript, left: string, right: string) {
  const normalize = ts.sys.useCaseSensitiveFileNames
    ? (fileName: string) => resolve(fileName)
    : (fileName: string) => resolve(fileName).toLowerCase()

  return normalize(left) === normalize(right)
}

function isNodeModulesPath(filePath: string) {
  return filePath.split(/[\\/]/).includes('node_modules')
}
