import { create } from 'zustand'
import { fetchModels } from './api/client.js'
import type { ModelInfo } from './api/types.js'
import {
  setModel,
  setRealtimeModel,
  setRealtimeVoice,
  setThinkingEffort,
  useSettings,
} from './settings.js'
import { resolveRealtimeVoice } from './speech/realtimeVoices.js'

/** 默认模型偏好：只用于从上游列表里挑默认值，可用模型名单完全来自上游 */
const PREFERRED_MODEL = 'deepseek-v4-flash'
/** 上游默认思考强度 */
const PREFERRED_EFFORT = 'high'

type ModelsState = {
  models: ModelInfo[]
  /** 实时语音模型（上游列表中的 realtime 模型），供语音通话选择 */
  realtimeModels: ModelInfo[]
  /** idle：没有 API Key；error：拉取失败或列表为空，保留上次成功的列表 */
  status: 'idle' | 'loading' | 'ready' | 'error'
}

export const useModels = create<ModelsState>(() => ({
  models: [],
  realtimeModels: [],
  status: 'idle',
}))

/** 聊天模型：supported_endpoint_types 含 openai；字段缺省时宽容保留 */
const isChatModel = (info: ModelInfo) =>
  info.supported_endpoint_types === undefined || info.supported_endpoint_types.includes('openai')

/** 实时语音模型：id 或端点类型含 realtime（网关可能以任意映射名暴露） */
const isRealtimeModel = (info: ModelInfo) =>
  info.id.toLowerCase().includes('realtime') ||
  (info.supported_endpoint_types?.some((type) => type.toLowerCase().includes('realtime')) ?? false)

/** 展示按模型名称自然排序（版本号按数值比较），上游返回顺序不稳定 */
const byId = (a: ModelInfo, b: ModelInfo) =>
  a.id.localeCompare(b.id, undefined, { numeric: true, sensitivity: 'base' })

/** 按模型的 reasoning_options 校正思考强度：优先 high，否则第一项；不支持强度时清空 */
const reconcileEffort = (info: ModelInfo | undefined) => {
  const options = info?.reasoning_options
  const { thinkingEffort } = useSettings.getState()
  if (!options || options.length === 0) {
    if (thinkingEffort !== null) {
      setThinkingEffort(null)
    }
    return
  }
  if (thinkingEffort !== null && options.includes(thinkingEffort)) {
    return
  }
  setThinkingEffort(options.includes(PREFERRED_EFFORT) ? PREFERRED_EFFORT : options[0])
}

/** 已保存模型不在列表时挑默认：优先 deepseek-v4-flash，否则第一个；同时校正思考强度 */
const reconcileSelection = (models: ModelInfo[]) => {
  const { model } = useSettings.getState()
  const current = models.find((info) => info.id === model)
  if (current) {
    reconcileEffort(current)
    return
  }
  const next = models.find((info) => info.id === PREFERRED_MODEL) ?? models[0]
  setModel(next.id)
  reconcileEffort(next)
}

const reconcileRealtimeVoice = (model: string | null) => {
  const { realtimeVoice } = useSettings.getState()
  const next = resolveRealtimeVoice(model, realtimeVoice)
  if (next !== realtimeVoice) {
    setRealtimeVoice(next)
  }
}

/** 已保存实时语音模型不在列表时挑默认：优先 omni 系列，否则第一个；列表为空则清空 */
const reconcileRealtimeSelection = (models: ModelInfo[]) => {
  const { realtimeModel } = useSettings.getState()
  if (models.some((info) => info.id === realtimeModel)) {
    reconcileRealtimeVoice(realtimeModel)
    return
  }
  const next = models.find((info) => info.id.toLowerCase().includes('omni')) ?? models[0]
  setRealtimeModel(next?.id ?? null)
  reconcileRealtimeVoice(next?.id ?? null)
}

let refreshSeq = 0
let readyKey: string | null = null

/** 拉取上游模型列表；同一 Key 已成功加载时不重复请求，过期响应不覆盖新结果 */
export const refreshModels = async () => {
  // 先递增序号：清除 Key 或提前返回时，也要让仍在途的旧响应失效。
  const seq = ++refreshSeq
  const apiKey = useSettings.getState().apiKey
  if (!apiKey) {
    readyKey = null
    useModels.setState({ models: [], realtimeModels: [], status: 'idle' })
    return
  }
  if (useModels.getState().status === 'ready' && readyKey === apiKey) {
    return
  }
  useModels.setState({ status: 'loading' })
  try {
    const raw = await fetchModels(apiKey)
    if (seq !== refreshSeq) {
      return
    }
    const list = raw.filter(isChatModel)
    const realtimeList = raw.filter(isRealtimeModel).sort(byId)
    if (list.length === 0) {
      useModels.setState({ status: 'error' })
      return
    }
    readyKey = apiKey
    useModels.setState({ models: list.sort(byId), realtimeModels: realtimeList, status: 'ready' })
    reconcileSelection(list)
    reconcileRealtimeSelection(realtimeList)
  } catch {
    if (seq !== refreshSeq) {
      return
    }
    useModels.setState({ status: 'error' })
  }
}

/** 界面切换模型：持久化选择，并按新模型校正思考强度 */
export const selectModel = (id: string) => {
  setModel(id)
  reconcileEffort(useModels.getState().models.find((info) => info.id === id))
}

/** 启动时刷新并监听 API Key 变化；返回清理函数 */
export const bindModels = () => {
  void refreshModels()
  return useSettings.subscribe((state, previous) => {
    if (state.apiKey !== previous.apiKey) {
      void refreshModels()
    }
  })
}
