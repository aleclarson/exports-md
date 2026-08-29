import { execFile as execFileCallback } from 'node:child_process'
import { mkdirSync, readdirSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, extname, join, relative, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import { extract as extractTar } from 'tar'
import {
  isDeclarationFile,
  isDirectory,
  isFile,
  isRecord,
  isSameOrChildPath,
  replaceEntryPointExtension,
} from './files.ts'
import type {
  PackageEntryPoint,
  PackageJson,
  PackageMarkdownEntry,
  TemporaryNpmPackage,
} from './internal-types.ts'

const execFile = promisify(execFileCallback)

export async function withNpmPackage<T>(
  packageSpec: string,
  cwd: string,
  callback: (packageJsonFile: string) => Promise<T>,
) {
  const temporaryPackage = await fetchNpmPackage(packageSpec, cwd)

  try {
    return await callback(temporaryPackage.packageJsonFile)
  } finally {
    await rm(temporaryPackage.tempDir, { recursive: true, force: true })
  }
}

async function fetchNpmPackage(packageSpec: string, cwd: string): Promise<TemporaryNpmPackage> {
  const tempDir = await mkdtemp(join(tmpdir(), 'exports-md-package-'))

  try {
    const archiveDir = join(tempDir, 'archive')
    const packageRoot = join(tempDir, 'package')
    mkdirSync(archiveDir)
    mkdirSync(packageRoot)
    const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm'
    try {
      await execFile(
        npmCommand,
        ['pack', '--silent', '--ignore-scripts', '--pack-destination', archiveDir, packageSpec],
        { cwd, maxBuffer: 1024 * 1024 },
      )
    } catch (error) {
      const stderr =
        error && typeof error === 'object' && 'stderr' in error && typeof error.stderr === 'string'
          ? error.stderr.trim()
          : ''
      const detail = stderr || (error instanceof Error ? error.message : String(error))
      throw new Error(`Could not fetch npm package ${packageSpec}: ${detail}`)
    }

    const archives = readdirSync(archiveDir).filter((file) => file.endsWith('.tgz'))
    if (archives.length !== 1) {
      throw new Error(`Could not fetch npm package ${packageSpec}: npm pack produced no tarball.`)
    }

    await extractTar({
      cwd: packageRoot,
      file: join(archiveDir, archives[0]!),
      preserveOwner: false,
      strip: 1,
      strict: true,
    })

    const packageJsonFile = join(packageRoot, 'package.json')
    if (!isFile(packageJsonFile)) {
      throw new Error(`Fetched npm package ${packageSpec} has no package.json.`)
    }

    return { packageJsonFile, tempDir }
  } catch (error) {
    await rm(tempDir, { recursive: true, force: true })
    throw error
  }
}

export function isNpmPackageSpec(value: string) {
  if (
    value.length === 0 ||
    value.startsWith('.') ||
    value.startsWith('/') ||
    value.includes('\\') ||
    ['.cjs', '.cts', '.js', '.json', '.mjs', '.mts', '.ts', '.tsx'].includes(extname(value))
  ) {
    return false
  }

  return /^(?:@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*|[a-z0-9][a-z0-9._-]*)(?:@[^/\\:]+)?$/i.test(
    value,
  )
}

export async function readPackageJson(packageJsonFile: string) {
  try {
    return JSON.parse(await readFile(packageJsonFile, 'utf8')) as PackageJson
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(`Invalid package.json: ${packageJsonFile}`)
    }
    throw error
  }
}

export function getPackageName(packageJson: { name?: unknown }, packageJsonFile: string) {
  if (typeof packageJson.name === 'string' && packageJson.name.length > 0) {
    return packageJson.name
  }

  throw new Error(`Package name not found: ${packageJsonFile}`)
}

export function getPackageEntryHeading(packageName: string, exportSubpath: string) {
  if (exportSubpath === '.') return packageName

  return `${packageName}/${exportSubpath.replace(/^\.\//, '')}`
}

export function readPackageEntryPoints(packageJsonFile: string, packageJson: PackageJson) {
  const packageRoot = dirname(packageJsonFile)
  const exportsField = packageJson.exports

  if (exportsField === undefined) {
    const packageTypesTarget = getPackageTypesTarget(packageJson)
    if (!packageTypesTarget) {
      throw new Error(`Package exports not found: ${packageJsonFile}`)
    }

    return [
      {
        exportSubpath: '.',
        inputFile: resolvePackageTypesTarget(packageRoot, packageTypesTarget),
      },
    ]
  }

  const entryPoints: PackageEntryPoint[] = []

  if (isRecord(exportsField) && Object.keys(exportsField).some((key) => key.startsWith('.'))) {
    for (const [subpath, value] of Object.entries(exportsField)) {
      const entryTargets = collectPackageDeclarationTargets(value, packageJson, subpath)
      if (entryTargets.length === 0) {
        continue
      }
      for (const target of entryTargets) {
        entryPoints.push(...expandPackageTarget(packageRoot, subpath, target))
      }
    }
  } else {
    for (const target of collectPackageDeclarationTargets(exportsField, packageJson, '.')) {
      entryPoints.push(...expandPackageTarget(packageRoot, '.', target))
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

function collectPackageDeclarationTargets(
  value: unknown,
  packageJson: PackageJson,
  exportSubpath: string,
) {
  const packageTypesTarget = exportSubpath === '.' ? getPackageTypesTarget(packageJson) : undefined
  const declarationTargets = collectDeclarationTargets(value)

  if (packageTypesTarget && !hasTypesCondition(value) && !hasExplicitDeclarationTarget(value)) {
    return [packageTypesTarget]
  }

  return declarationTargets.length > 0
    ? declarationTargets
    : packageTypesTarget
      ? [packageTypesTarget]
      : []
}

function getPackageTypesTarget(packageJson: PackageJson) {
  if (typeof packageJson.types === 'string' && packageJson.types.length > 0) {
    return packageJson.types
  }

  if (typeof packageJson.typings === 'string' && packageJson.typings.length > 0) {
    return packageJson.typings
  }
}

function hasTypesCondition(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.some((item) => hasTypesCondition(item))
  }

  if (!isRecord(value)) return false
  if (typeof value.types === 'string') return true

  return Object.values(value).some((item) => hasTypesCondition(item))
}

function hasExplicitDeclarationTarget(value: unknown): boolean {
  if (typeof value === 'string') {
    return isDeclarationFile(value) || ['.ts', '.mts', '.cts', '.tsx'].includes(extname(value))
  }

  if (Array.isArray(value)) {
    return value.some((item) => hasExplicitDeclarationTarget(item))
  }

  if (!isRecord(value)) return false

  return Object.values(value).some((item) => hasExplicitDeclarationTarget(item))
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
    return `${target.slice(0, -'.mjs'.length)}.d.mts`
  }

  if (target.endsWith('.cjs')) {
    return `${target.slice(0, -'.cjs'.length)}.d.cts`
  }
}

function expandPackageTarget(
  packageRoot: string,
  exportSubpath: string,
  target: string,
): PackageEntryPoint[] {
  const candidateTargets = getPackageTargetCandidates(target)

  for (const [index, candidateTarget] of candidateTargets.entries()) {
    const resolvedTarget = resolvePackageTarget(packageRoot, candidateTarget)
    if (!candidateTarget.includes('*')) {
      if (isFile(resolvedTarget) || index === candidateTargets.length - 1) {
        return [
          {
            exportSubpath,
            inputFile: resolvedTarget,
          },
        ]
      }

      continue
    }

    const entryPoints = expandPackageTargetPattern(packageRoot, exportSubpath, candidateTarget)
    if (entryPoints.length > 0 || index === candidateTargets.length - 1) {
      return entryPoints
    }
  }

  return []
}

function getPackageTargetCandidates(target: string) {
  if (target.endsWith('.d.mts')) {
    return [target, `${target.slice(0, -'.d.mts'.length)}.d.ts`]
  }

  if (target.endsWith('.d.cts')) {
    return [target, `${target.slice(0, -'.d.cts'.length)}.d.ts`]
  }

  return [target]
}

function expandPackageTargetPattern(
  packageRoot: string,
  exportSubpath: string,
  target: string,
): PackageEntryPoint[] {
  const targetPattern = target.slice(2)
  const wildcardIndex = targetPattern.indexOf('*')
  const staticDirectoryEnd = targetPattern.lastIndexOf('/', wildcardIndex)
  const staticDirectory =
    staticDirectoryEnd === -1 ? '' : targetPattern.slice(0, staticDirectoryEnd)
  const searchRoot = resolve(packageRoot, staticDirectory || '.')
  const matcher = new RegExp(
    `^${targetPattern
      .split('*')
      .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
      .join('(.*)')}$`,
  )

  return collectPackageFiles(searchRoot)
    .map((inputFile) => {
      const targetFile = relative(packageRoot, inputFile).split(sep).join('/')
      const match = matcher.exec(targetFile)
      if (!match) return undefined

      return {
        exportSubpath: replacePackageExportPattern(exportSubpath, match.slice(1)),
        inputFile: resolvePackageTarget(packageRoot, `./${targetFile}`),
      }
    })
    .filter((entry): entry is PackageEntryPoint => entry !== undefined)
}

function collectPackageFiles(directory: string): string[] {
  if (!isDirectory(directory)) return []

  const files: string[] = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) {
      files.push(...collectPackageFiles(path))
    } else if (entry.isFile()) {
      files.push(path)
    }
  }

  return files.sort()
}

function replacePackageExportPattern(exportSubpath: string, captures: readonly string[]) {
  let captureIndex = 0
  return exportSubpath.replace(/\*/g, () => captures[captureIndex++] ?? '')
}

function resolvePackageTarget(packageRoot: string, target: string) {
  if (!target.startsWith('./')) {
    throw new Error(`Package export target must be relative to the package root: ${target}`)
  }

  const resolvedTarget = resolve(packageRoot, target)
  if (!isSameOrChildPath(packageRoot, resolvedTarget)) {
    throw new Error(`Package export target must stay within the package root: ${target}`)
  }

  return resolvedTarget
}

function resolvePackageTypesTarget(packageRoot: string, target: string) {
  return resolvePackageTarget(packageRoot, target.startsWith('./') ? target : `./${target}`)
}

export async function writePackageMarkdownFiles(entries: PackageMarkdownEntry[], outDir: string) {
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
