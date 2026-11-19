import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslate } from '../../i18n/index.js'
import { ACCEPT } from '../../services/attachments.js'
import { addDraftFiles, EMPTY_DRAFT, useDrafts } from '../../services/chat/drafts.js'
import { useModels } from '../../services/models.js'
import {
  changeRealtimeModel,
  changeRealtimeVoice,
  endRealtimeCall,
  getRealtimeAnalyser,
  sendRealtimeImages,
  toggleRealtimeMute,
  useRealtime,
} from '../../services/speech/realtime.js'
import {
  getRealtimeVoiceOptions,
  resolveRealtimeVoice,
} from '../../services/speech/realtimeVoices.js'
import { IconButton } from '../base/IconButton.js'
import {
  IconMicOffOutline16,
  IconMicOutline16,
  IconPaperclipOutline16,
  IconPhoneDownFill16,
  IconSendOutline16,
} from '../base/icons.js'
import { Select } from '../base/Select.js'
import { showToast } from '../base/toastState.js'
import { Spectrum } from './Spectrum.js'
import styles from './RealtimeCallBar.module.css'

/**
 * 通话条：通话中替代输入区。频谱 + 状态与用户实时字幕 + 模型/音色选择 + 静音/挂断。
 * AI 回复文字直接流进消息列表，这里只显示用户侧的实时转写。
 * 通话中可发图片：回形针/粘贴进草稿，发送后交给实时会话；草稿文字保留到挂断。
 */
export const RealtimeCallBar = () => {
  const t = useTranslate()
  const status = useRealtime((state) => state.status)
  const speaking = useRealtime((state) => state.speaking)
  const muted = useRealtime((state) => state.muted)
  const toolRunning = useRealtime((state) => state.toolRunning)
  const userText = useRealtime((state) => state.userText)
  const model = useRealtime((state) => state.model)
  const voice = useRealtime((state) => state.voice)
  const sessionId = useRealtime((state) => state.chatSessionId)
  const realtimeModels = useModels((state) => state.realtimeModels)
  const attachments = useDrafts(
    (state) => state.drafts.get(sessionId)?.attachments ?? EMPTY_DRAFT.attachments
  )
  const [sending, setSending] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const acceptFiles = useCallback(
    (files: File[]) => {
      if (files.length === 0 || sessionId === null) {
        return
      }
      const error = addDraftFiles(sessionId, files)
      if (error) {
        showToast(error)
      }
    },
    [sessionId]
  )

  // 通话中没有文本框，挂全局粘贴监听保留粘贴上传入口
  useEffect(() => {
    const onPaste = (event: ClipboardEvent) => {
      const files = Array.from(event.clipboardData?.files ?? [])
      if (files.length > 0) {
        event.preventDefault()
        acceptFiles(files)
      }
    }
    window.addEventListener('paste', onPaste)
    return () => window.removeEventListener('paste', onPaste)
  }, [acceptFiles])

  const sendImages = async () => {
    if (sending) {
      return
    }
    setSending(true)
    try {
      await sendRealtimeImages()
    } finally {
      setSending(false)
    }
  }

  const statusText =
    status === 'connecting'
      ? t('realtimeConnecting')
      : muted
        ? t('realtimeMuted')
        : speaking === 'user'
          ? t('realtimeUserSpeaking')
          : toolRunning
            ? t('mcpToolRunning')
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
          value={resolveRealtimeVoice(model, voice)}
          options={getRealtimeVoiceOptions(model)}
          searchable
          searchPlaceholder={t('realtimeVoiceSearchPlaceholder')}
          noMatchText={t('realtimeVoiceNoMatch')}
          onChange={changeRealtimeVoice}
        />
        <IconButton
          size="m"
          tone="tertiary"
          icon={<IconPaperclipOutline16 />}
          tooltip={t('uploadFile')}
          onClick={() => fileInputRef.current?.click()}
        />
        <input
          ref={fileInputRef}
          type="file"
          multiple
          hidden
          accept={ACCEPT}
          onChange={(event) => {
            acceptFiles(Array.from(event.target.files ?? []))
            event.target.value = ''
          }}
        />
        {attachments.length > 0 ? (
          <IconButton
            size="m"
            tone="primary"
            icon={<IconSendOutline16 />}
            tooltip={t('realtimeSendImages')}
            disabled={sending || status !== 'active' || toolRunning}
            onClick={() => void sendImages()}
          />
        ) : null}
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
