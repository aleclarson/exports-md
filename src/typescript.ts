import { existsSync } from 'node:fs'
import { execFile as execFileCallback } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
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
): Promise<string> {
  const tsrxTsc = findTsrxTsc(inputFile) ?? findTsrxTsc(cwd)
  if (extname(inputFile) === '.tsrx' || tsrxTsc) {
    if (!tsrxTsc) {
      throw new Error(`Compiling ${inputFile} requires @tsrx/typescript-plugin in the workspace`)
    }
    return compileWithTsrxTsc(ts, inputFile, cwd, tsrxTsc)
  }

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

export function resolveModuleTarget(
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

  let resolvedFileName = ts.resolveModuleName(moduleSpecifier, inputFile, options, ts.sys)
    .resolvedModule?.resolvedFileName
  if (!resolvedFileName && moduleSpecifier.startsWith('.')) {
    const candidate = resolve(dirname(inputFile), moduleSpecifier)
    const candidates = candidate.endsWith('.tsrx')
      ? [candidate]
      : [`${candidate}.tsrx`, join(candidate, 'index.tsrx')]
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

function getCompilerOptions(ts: TypeScript, inputFile: string, cwd: string) {
  const configPath = findTsConfig(inputFile)
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

function compileWithTsrxTsc(ts: TypeScript, inputFile: string, cwd: string, tscPath: string) {
  return compileWithTsrxTscAsync(ts, inputFile, cwd, tscPath)
}

function compileWithTsrxTscAsync(
  ts: TypeScript,
  inputFile: string,
  cwd: string,
  tscPath: string,
) {
  return (async () => {
    const baseConfig = findTsConfig(inputFile)
    const baseOptions = baseConfig ? readConfigOptions(ts, baseConfig, cwd) : {}
    const tempDir = await mkdtemp(join(tmpdir(), 'exports-md-tsrx-'))
    const outputDir = join(tempDir, 'declarations')
    const configPath = join(tempDir, 'tsconfig.json')
    const config = {
      ...(baseConfig ? { extends: baseConfig } : {}),
      files: [resolve(inputFile)],
      include: [],
      compilerOptions: {
        declaration: true,
        declarationMap: false,
        emitDeclarationOnly: true,
        noEmit: false,
        noEmitOnError: true,
        outDir: outputDir,
        skipLibCheck: true,
        sourceMap: false,
        ...(baseOptions.target === undefined ? { target: 'ES2022' } : {}),
      },
    }

    try {
      await writeFile(configPath, JSON.stringify(config))
      await execFile(process.execPath, [tscPath, '--project', configPath, '--pretty', 'false'], {
        cwd,
        maxBuffer: 10 * 1024 * 1024,
      })
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
    } catch (error) {
      if (error && typeof error === 'object' && 'stderr' in error && typeof error.stderr === 'string') {
        throw new Error(error.stderr.trim() || `Could not compile TSRX module ${inputFile}`)
      }
      throw error
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  })()
}

async function collectDeclarationFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => [])
  const files: string[] = []
  for (const entry of entries) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) files.push(...(await collectDeclarationFiles(path)))
    else if (
      entry.isFile() &&
      (entry.name.endsWith('.d.ts') || entry.name.endsWith('.d.mts') || entry.name.endsWith('.d.cts'))
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
