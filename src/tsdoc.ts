import type { Node } from 'typescript'
import type { RenderedTsDoc, TsDoc, TsDocTag, TypeScript } from './internal-types.ts'

export function getLeadingTsDoc(ts: TypeScript, text: string, node: Node) {
  return getLeadingTsDocComment(ts, text, node)?.raw
}

export function getLeadingTsDocComment(ts: TypeScript, text: string, node: Node) {
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

export function parseTsDoc(comment: string): TsDoc {
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

export function renderTsDoc(doc: TsDoc): RenderedTsDoc {
  const tagBlocks: string[] = []
  const params = doc.tags.filter((tag) => tag.name === 'param')
  const typeParams = doc.tags.filter((tag) => tag.name === 'typeParam' || tag.name === 'template')
  const returns = doc.tags.filter((tag) => tag.name === 'returns' || tag.name === 'return')
  const deprecated = doc.tags.find((tag) => tag.name === 'deprecated')
  const remarks = doc.tags.find((tag) => tag.name === 'remarks')
  const examples = doc.tags.filter((tag) => tag.name === 'example')

  if (deprecated) {
    tagBlocks.push(`**Deprecated.** ${deprecated.text}`.trimEnd())
  }

  if (remarks?.text) {
    tagBlocks.push(`**Remarks**\n\n${remarks.text}`)
  }

  if (typeParams.length > 0) {
    tagBlocks.push(renderNamedTags('Type Parameters', typeParams))
  }

  if (params.length > 0) {
    tagBlocks.push(renderNamedTags('Parameters', params))
  }

  if (returns.length > 0) {
    tagBlocks.push(`**Returns**\n\n${returns.map((tag) => tag.text).join('\n\n')}`)
  }

  if (examples.length > 0) {
    tagBlocks.push(`**Examples**\n\n${examples.map((tag) => tag.text).join('\n\n')}`)
  }

  return {
    body: doc.body,
    tags: tagBlocks.join('\n\n'),
  }
}

export function renderTsDocMarkdown(doc: TsDoc) {
  const rendered = renderTsDoc(doc)
  return [rendered.body, rendered.tags].filter(Boolean).join('\n\n')
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
