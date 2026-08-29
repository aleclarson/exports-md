export type PropertyDocMode = 'inline' | 'list'

export interface GeneratedMarkdown {
  declaration: string
  fromCache: boolean
  inputFile: string
  markdown: string
  warnings: string[]
}

export interface GitHubOptions {
  repository?: string
  searchLinks?: boolean
}

export interface GenerateMarkdownOptions {
  cwd?: string
  followImports?: boolean
  followReExports?: boolean
  github?: GitHubOptions
  outDir?: string
  propertyDocs?: PropertyDocMode
  reverseSymbols?: boolean
  groupBySyntax?: boolean
  sortByName?: boolean
  symbols?: string[]
}
