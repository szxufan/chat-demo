import { useTranslate } from '../../i18n/index.js'
import { useModels } from '../../services/models.js'
import {
  changeRealtimeModel,
  changeRealtimeVoice,
  endRealtimeCall,
  getRealtimeAnalyser,
  REALTIME_VOICES,
  toggleRealtimeMute,
  useRealtime,
} from '../../services/speech/realtime.js'
import { IconButton } from '../base/IconButton.js'
import { IconMicOffOutline16, IconMicOutline16, IconPhoneDownFill16 } from '../base/icons.js'
import { Select } from '../base/Select.js'
import { Spectrum } from './Spectrum.js'
import styles from './RealtimeCallBar.module.css'

/**
 * 通话条：通话中替代输入区。频谱 + 状态与用户实时字幕 + 模型/音色选择 + 静音/挂断。
 * AI 回复文字直接流进消息列表，这里只显示用户侧的实时转写。
 */
export const RealtimeCallBar = () => {
  const t = useTranslate()
  const status = useRealtime((state) => state.status)
  const speaking = useRealtime((state) => state.speaking)
  const muted = useRealtime((state) => state.muted)
  const userText = useRealtime((state) => state.userText)
  const model = useRealtime((state) => state.model)
  const voice = useRealtime((state) => state.voice)
  const realtimeModels = useModels((state) => state.realtimeModels)

  const statusText =
    status === 'connecting'
      ? t('realtimeConnecting')
      : muted
        ? t('realtimeMuted')
        : speaking === 'user'
          ? t('realtimeUserSpeaking')
          : speaking === 'assistant'
            ? t('realtimeAssistantSpeaking')
            : t('realtimeListening')

  return (
    <div className={styles.bar}>
      <div className={styles.main}>
        <div className={styles.spectrumWrap}>
          <Spectrum getAnalyser={getRealtimeAnalyser} />
        </div>
        <div className={styles.caption}>
          <span className={styles.status} aria-live="polite">
            {statusText}
          </span>
          {userText ? <span className={styles.userText}>{userText}</span> : null}
        </div>
      </div>
      <div className={styles.controls}>
        <Select
          className={styles.select}
          ariaLabel={t('realtimeModelSelector')}
          value={model ?? ''}
          placeholder={t('realtimeModelSelector')}
          searchable
          searchPlaceholder={t('modelSearchPlaceholder')}
          noMatchText={t('modelNoMatch')}
          options={realtimeModels.map((info) => ({ value: info.id, label: info.id }))}
          onChange={changeRealtimeModel}
        />
        <Select
          className={styles.select}
          ariaLabel={t('realtimeVoiceSelector')}
          value={voice}
          options={REALTIME_VOICES.map((name) => ({ value: name, label: name }))}
          onChange={changeRealtimeVoice}
        />
        <IconButton
          size="m"
          tone={muted ? 'primary' : 'tertiary'}
          icon={muted ? <IconMicOffOutline16 /> : <IconMicOutline16 />}
          tooltip={muted ? t('realtimeUnmute') : t('realtimeMute')}
          aria-pressed={muted}
          onClick={toggleRealtimeMute}
        />
        <button
          type="button"
          className={styles.hangup}
          aria-label={t('realtimeHangup')}
          onClick={endRealtimeCall}
        >
          <IconPhoneDownFill16 />
        </button>
      </div>
    </div>
  )
}
