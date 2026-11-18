import type { Nodes, Parent } from 'mdast'
import { fromMarkdown } from 'mdast-util-from-markdown'
import { gfmFromMarkdown } from 'mdast-util-gfm'
import { mathFromMarkdown } from 'mdast-util-math'
import { gfm } from 'micromark-extension-gfm'
import { math } from 'micromark-extension-llm-math'

/**
 * 把正文 Markdown 转成适合朗读的纯文本（仅 MiMo TTS 使用；DeepSeek 由上游 filter_markdown 过滤）。
 * 复用与渲染一致的解析器（GFM + 数学公式），按 AST 提取可朗读文字：
 * 保留文本、链接/强调/删除线的文字、行内代码、标题/列表/段落；
 * 跳过代码块、表格、公式、图片、HTML、引用角标、脚注与分隔线。
 */

/** 行内容器：子节点拼接不额外加空格（文本节点自带原始空白，中文无需插空格） */
const inlineText = (node: Parent): string => node.children.map(speechText).join('')

/** 块级容器：子节点用换行衔接，保留语句停顿 */
const blockText = (node: Parent): string =>
  node.children.map(speechText).filter(Boolean).join('\n')

/** 数字开头且包含明确公式语法的候选仍交给数学解析，其余按货币处理 */
const looksLikeMath = (value: string): boolean => {
  if (/[-+*/=^<>|:]\s*$/.test(value)) {
    return false
  }
  return (
    /[\\+*/=^<>|!:]/.test(value) ||
    /-(?!\s*$)/.test(value) ||
    /^\s*\d[\d.,]*(?:\s*[a-z]\s*|[a-z]+\s*)$/i.test(value)
  )
}

/** 单美元数学语法会把两个价格之间的正文吞成公式；占位保护货币但保留 $x$、$5+2$ 等公式 */
const protectCurrencyDollars = (input: string, marker: string): string => {
  let result = ''
  let copied = 0
  for (const match of input.matchAll(/(?<!\\)\$(?=\d)/g)) {
    const start = match.index
    const closing = input.indexOf('$', start + 1)
    if (closing !== -1 && looksLikeMath(input.slice(start + 1, closing))) {
      continue
    }
    result += input.slice(copied, start) + marker
    copied = start + 1
  }
  return result + input.slice(copied)
}

const speechText = (node: Nodes): string => {
  switch (node.type) {
    case 'text':
      // 只清理文本节点，避免在解析前破坏链接、图片和行内代码的 Markdown 结构
      return node.value.replace(/\[citation:\d+\]/g, '')
    case 'inlineCode':
      return node.value
    case 'break':
      return '\n'
    case 'html':
      return /^<br\s*\/?>$/i.test(node.value) ? '\n' : ''
    case 'inlineMath':
    case 'image':
    case 'imageReference':
    case 'footnoteReference':
      // 跳过行内内容时保留词边界，避免两侧英文粘成一个词
      return ' '
    case 'link':
    case 'linkReference': {
      const value = inlineText(node as Parent)
      // 链接标签的方括号不会进入 text 节点，因此还需识别 citation:N 形式
      return !value || /^citation:\d+$/.test(value.trim()) ? ' ' : value
    }
    case 'emphasis':
    case 'strong':
    case 'delete':
    case 'paragraph':
    case 'heading':
    case 'tableCell':
      return inlineText(node as Parent)
    case 'root':
    case 'list':
    case 'listItem':
    case 'blockquote':
      return blockText(node as Parent)
    // code / table / math / html / citation / 脚注定义 / 分隔线等不朗读
    default:
      return ''
  }
}

export const toSpeechText = (input: string): string => {
  // 使用输入中不存在的私有区字符，解析后统一还原；inline code 中也不会留下 Markdown 转义符
  let currencyMarker = '\uE000'
  while (input.includes(currencyMarker)) {
    currencyMarker += '\uE000'
  }
  const ast = fromMarkdown(protectCurrencyDollars(input, currencyMarker), {
    extensions: [
      // 与 parse.ts 一致：禁用缩进代码块，避免前导空格列表被误判
      { ...gfm(), disable: { null: ['codeIndented'] } },
      math({ singleDollarTextMath: true }),
    ],
    mdastExtensions: [gfmFromMarkdown(), mathFromMarkdown()],
  })
  return speechText(ast)
    .replaceAll(currencyMarker, '$')
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n+/g, '\n')
    .trim()
}
