import { useTranslate } from '../../i18n/index.js'
import type { MessageUsage } from '../../services/api/types.js'
import { Tooltip } from '../base/Tooltip.js'
import styles from './UsageBadge.module.css'

/** 与 history/toArchive.ts 的 contextTokens 口径一致：输入（含缓存）与输出之和。 */
const totalTokens = (usage: MessageUsage) =>
  usage.input_tokens +
  usage.cache_creation_input_tokens +
  usage.cache_read_input_tokens +
  usage.output_tokens

/** 回复底部的用量角标：常显总 token，悬停展示输入/缓存命中/输出明细（移动端仅显示总数）。 */
export const UsageBadge = ({ usage }: { usage: MessageUsage }) => {
  const t = useTranslate()
  const format = (value: number) => value.toLocaleString()
  return (
    <Tooltip
      placement="top"
      content={
        <div className={styles.breakdown}>
          <div>{t('messageUsageInput', { count: format(usage.input_tokens) })}</div>
          <div>{t('messageUsageCacheRead', { count: format(usage.cache_read_input_tokens) })}</div>
          <div>{t('messageUsageOutput', { count: format(usage.output_tokens) })}</div>
        </div>
      }
    >
      <span className={styles.usage}>
        {t('messageUsageTokens', { count: format(totalTokens(usage)) })}
      </span>
    </Tooltip>
  )
}
