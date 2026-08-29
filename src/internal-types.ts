import type { Statement } from 'typescript'
import type { GitHubOptions, PropertyDocMode } from './types.ts'

export type TypeScript = typeof import('typescript')

export interface TsDocTag {
  name: string
  text: string
}

export interface TsDoc {
  body: string
  tags: TsDocTag[]
}

export interface RenderedTsDoc {
  body: string
  tags: string
}

export interface DeclarationEntry {
  code: string
  exportedName: string
  index: number
  isExported: boolean
  localName: string
  statement: Statement
}

export interface ImportEntry {
  code: string
  importedNameAliases: Map<string, string>
  importedNames: Set<string>
  index: number
  moduleSpecifier: string
  statement: Statement
}

export interface ReExportEntry {
  code: string
  exportedNames: Set<string>
  exportsAll: boolean
  index: number
  moduleSpecifier: string
  statement: Statement
}

export interface ImportedReExportEntry {
  exportedName: string
  importEntry: ImportEntry
  sourceName: string
}

export interface CachedMarkdown {
  declaration: string
  markdown: string
}

export interface PackageMarkdownEntry {
  declaration: string
  foundSymbols: Set<string>
  fromCache: boolean
  inputFile: string
  markdown: string
  warnings: string[]
}

export interface PackageEntryPoint {
  exportSubpath: string
  inputFile: string
}

export interface PackageJson {
  exports?: unknown
  name?: unknown
  types?: unknown
  typings?: unknown
}

export interface TemporaryNpmPackage {
  packageJsonFile: string
  tempDir: string
}

export interface PropertyDoc {
  name: string
  docs: string
}

export interface CodeEdit {
  end: number
  replacement: string
  start: number
}

export interface RenderContext {
  cwd: string
  followImports: boolean
  followReExports: boolean
  github?: GitHubOptions
  inputFile: string
  propertyDocs: PropertyDocMode
  reverseSymbols: boolean
  groupBySyntax: boolean
  sortByName: boolean
  visited: Set<string>
  warnings: string[]
}
