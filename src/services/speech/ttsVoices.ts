import type { TranslationKey } from '../../i18n/index.js'

/** 朗读音色选项：value 为上游音色 id，labelKey 交给界面按当前语言组装显示名 */
export type TtsVoiceOption = {
  value: string
  labelKey: TranslationKey
}

/** DeepSeek 原生 TTS 音色（/v1/tools/tts） */
const DEEPSEEK_VOICES: TtsVoiceOption[] = [
  { value: 'stella', labelKey: 'settingsTtsVoiceStella' },
  { value: 'tide', labelKey: 'settingsTtsVoiceTide' },
]

/** MiMo 预置音色（mimo-v2.5-tts，/v1/audio/speech）；mimo_default 按集群映射到冰糖或 Mia */
const MIMO_VOICES: TtsVoiceOption[] = [
  { value: 'mimo_default', labelKey: 'settingsTtsVoiceMimoDefault' },
  { value: '冰糖', labelKey: 'settingsTtsVoiceBingtang' },
  { value: '茉莉', labelKey: 'settingsTtsVoiceMoli' },
  { value: '苏打', labelKey: 'settingsTtsVoiceSuda' },
  { value: '白桦', labelKey: 'settingsTtsVoiceBaihua' },
  { value: 'Mia', labelKey: 'settingsTtsVoiceMia' },
  { value: 'Chloe', labelKey: 'settingsTtsVoiceChloe' },
  { value: 'Milo', labelKey: 'settingsTtsVoiceMilo' },
  { value: 'Dean', labelKey: 'settingsTtsVoiceDean' },
]

/** MiMo 预置音色 TTS 模型（排除 voicedesign/voiceclone，二者需额外输入） */
export const isMimoTtsModel = (model: string | null): boolean => {
  const id = model?.toLowerCase() ?? ''
  return id.includes('mimo') && id.endsWith('tts')
}

/** MiMo 语音识别模型 */
export const isMimoAsrModel = (model: string | null): boolean => {
  const id = model?.toLowerCase() ?? ''
  return id.includes('mimo') && id.includes('asr')
}

/** 仅支持 MiMo 预置音色 TTS；其他提供商会走错端点，voice design/clone 还需额外输入 */
export const isSupportedTtsModel = (model: string): boolean => {
  const id = model.toLowerCase()
  return isMimoTtsModel(model) && !id.includes('voicedesign') && !id.includes('voiceclone')
}

/** 按模型返回可选音色集合：MiMo 与 DeepSeek 音色范围不同 */
export const getTtsVoiceOptions = (model: string | null): TtsVoiceOption[] =>
  isMimoTtsModel(model) ? MIMO_VOICES : DEEPSEEK_VOICES

export const getDefaultTtsVoice = (model: string | null): string =>
  isMimoTtsModel(model) ? 'mimo_default' : 'stella'

/** 模型切换后若原音色不受支持，回退到该模型的默认音色 */
export const resolveTtsVoice = (model: string | null, selected: string | null): string => {
  const options = getTtsVoiceOptions(model)
  if (selected && options.some((option) => option.value === selected)) {
    return selected
  }
  return getDefaultTtsVoice(model)
}