import type { ChatFunctionTool } from '../api/types.js'
import { listMcpTools } from './client.js'

/** 模型侧工具名约束（OpenAI function name）；MCP 工具名可能含点号等非法字符 */
const TOOL_NAME_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/
/** 与内置搜索/链接阅读工具重名时跳过 MCP 侧声明，避免重复工具名被网关拒绝 */
const BUILTIN_NAMES = new Set(['deepseek_web_search', 'deepseek_read_url'])

const sanitizeName = (name: string) => {
  const cleaned = name.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64)
  return cleaned || 'mcp_tool'
}

export type McpToolset = {
  /** 声明给模型的 function 工具 */
  tools: ChatFunctionTool[]
  /** 暴露名 → MCP 原工具名 */
  route: Map<string, string>
}

/** 按 API Key 缓存工具列表；Key 变化或发现失败后失效 */
let cache: { apiKey: string; toolset: McpToolset } | null = null

export const invalidateMcpToolset = () => {
  cache = null
}

/** 发现并转换 MCP 工具；失败由调用方降级为普通对话 */
export const getMcpToolset = async (apiKey: string, signal?: AbortSignal): Promise<McpToolset> => {
  if (cache && cache.apiKey === apiKey) {
    return cache.toolset
  }
  const infos = await listMcpTools(apiKey, signal)
  const route = new Map<string, string>()
  const tools: ChatFunctionTool[] = []
  const used = new Set<string>(BUILTIN_NAMES)
  for (const info of infos) {
    let exposed = TOOL_NAME_PATTERN.test(info.name) ? info.name : sanitizeName(info.name)
    if (used.has(exposed)) {
      const base = exposed.slice(0, 60)
      let suffix = 2
      while (used.has(`${base}_${suffix}`)) {
        suffix += 1
      }
      exposed = `${base}_${suffix}`
    }
    used.add(exposed)
    route.set(exposed, info.name)
    tools.push({
      type: 'function',
      function: {
        name: exposed,
        description: info.description ?? '',
        parameters: info.inputSchema ?? { type: 'object', properties: {} },
      },
    })
  }
  const toolset: McpToolset = { tools, route }
  cache = { apiKey, toolset }
  return toolset
}
