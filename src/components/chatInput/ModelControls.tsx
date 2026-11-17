import type { ModelInfo } from '../../services/api/types.js'
import { refreshModels, selectModel, useModels } from '../../services/models.js'
import { setThinkingEffort, useSettings } from '../../services/settings.js'
import { useTranslate, type TranslationKey } from '../../i18n/index.js'
import { IconRefreshOutline16 } from '../base/icons.js'
import { Select } from '../base/Select.js'
import { Tooltip } from '../base/Tooltip.js'
import styles from './ChatInput.module.css'

/** 思考强度级别的展示名；未知级别原样显示 */
const EFFORT_LABELS: Record<string, TranslationKey> = {
  low: 'thinkingEffortLow',
  high: 'thinkingEffortHigh',
  xhigh: 'thinkingEffortXhigh',
  max: 'thinkingEffortMax',
}

type Translate = ReturnType<typeof useTranslate>

const effortLabel = (level: string, t: Translate) => {
  const key = EFFORT_LABELS[level]
  return key ? t(key) : level
}

const formatContextLength = (tokens: number) =>
  tokens >= 1_000_000
    ? `${Math.round(tokens / 1_000_000)}M`
    : tokens >= 1000
      ? `${Math.round(tokens / 1000)}K`
      : String(tokens)

/** 下拉项的能力摘要：上下文长度 · 图片输入 · 推理 */
const modelDescription = (info: ModelInfo, t: Translate) => {
  const parts: string[] = []
  if (info.context_length !== undefined) {
    parts.push(t('modelContextLength', { size: formatContextLength(info.context_length) }))
  }
  if (info.support_image_input) {
    parts.push(t('modelCapabilityImage'))
  }
  if (info.reasoning_options && info.reasoning_options.length > 0) {
    parts.push(t('modelCapabilityReasoning'))
  }
  return parts.length > 0 ? parts.join(' · ') : undefined
}

/** 模型选择器：列表来自上游；加载中/无 Key 时禁用，失败时显示重试按钮 */
export const ModelSelector = () => {
  const t = useTranslate()
  const models = useModels((state) => state.models)
  const status = useModels((state) => state.status)
  const model = useSettings((state) => state.model)

  if (status === 'error') {
    return (
      <Tooltip content={t('modelListRetry')}>
        <button
          type="button"
          className={styles.toggle}
          aria-label={t('modelListRetry')}
          onClick={() => void refreshModels()}
        >
          <IconRefreshOutline16 />
          <span className={styles.toggleLabel}>{t('modelListFailed')}</span>
        </button>
      </Tooltip>
    )
  }

  return (
    <Select
      className={styles.toolbarSelect}
      ariaLabel={t('modelSelector')}
      value={model ?? ''}
      placeholder={status === 'loading' ? t('modelSelectorLoading') : t('modelSelectorPlaceholder')}
      disabled={status !== 'ready'}
      options={models.map((info) => ({
        value: info.id,
        label: info.id,
        description: modelDescription(info, t),
      }))}
      onChange={selectModel}
    />
  )
}

/** 思考强度选择器：仅在开启深度思考且当前模型支持强度选择时显示 */
export const ThinkingEffortSelector = () => {
  const t = useTranslate()
  const thinking = useSettings((state) => state.thinking)
  const effort = useSettings((state) => state.thinkingEffort)
  const model = useSettings((state) => state.model)
  const options = useModels(
    (state) => state.models.find((info) => info.id === model)?.reasoning_options
  )

  if (!thinking || !options || options.length === 0) {
    return null
  }

  return (
    <Select
      className={styles.toolbarSelect}
      ariaLabel={t('thinkingEffortSelector')}
      value={effort ?? ''}
      options={options.map((level) => ({ value: level, label: effortLabel(level, t) }))}
      onChange={setThinkingEffort}
    />
  )
}
