import { statSync } from 'node:fs'
import { basename, extname, isAbsolute, relative } from 'node:path'

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function isFile(path: string) {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

export function isDirectory(path: string) {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

export function isPackageJson(path: string) {
  return basename(path) === 'package.json'
}

export function isDeclarationFile(path: string) {
  return path.endsWith('.d.ts') || path.endsWith('.d.mts') || path.endsWith('.d.cts')
}

export function isSameOrChildPath(parent: string, child: string) {
  const path = relative(parent, child)
  return path === '' || (!path.startsWith('..') && !isAbsolute(path))
}

export function replaceEntryPointExtension(path: string) {
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
