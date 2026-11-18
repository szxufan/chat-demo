export type RealtimeVoiceOption = {
  value: string
  label: string
}

const voice = (value: string, name: string): RealtimeVoiceOption => ({
  value,
  label: `${value}（${name}）`,
})

/** Qwen3.8-Omni 音色，顺序与百炼音色列表一致。 */
const QWEN38_OMNI_VOICES: RealtimeVoiceOption[] = [
  voice('Tina', '甜甜'),
  voice('Cindy', '林欣宜'),
  voice('Liora Mira', '清欢'),
  voice('Raymond', '林川野'),
  voice('Zane', '泽恩'),
  voice('Katerina', '卡捷琳娜'),
  voice('Ryan', '甜茶'),
  voice('Mia', '温柔生活博主-舒然'),
  voice('Cici', '绵绵'),
  voice('Theo Calm', '予安'),
  voice('Serena', '苏瑶'),
  voice('Maia', '四月'),
  voice('Evan', '江晨'),
  voice('Qiao', '小乔妹'),
  voice('Momo', '茉兔'),
  voice('Wil', '伟伦'),
  voice('Angel', '台普-安琪'),
  voice('Li Cassian', '东厂-李公公'),
  voice('Joyner', '喜剧担当-阿逗'),
  voice('Gold', '金爷'),
  voice('Jennifer', '詹妮弗'),
  voice('Aiden', '艾登'),
  voice('Mione', '敏儿'),
  voice('Sunny', '四川-晴儿'),
  voice('Dylan', '北京-晓东'),
  voice('Eric', '四川-程川'),
  voice('Peter', '天津-李彼得'),
  voice('Joseph Chen', '阿樸伯'),
  voice('Marcus', '陕西-秦川'),
  voice('Li', '南京-老李'),
  voice('Rocky', '粤语-阿强'),
  voice('Kiki', '粤语-阿清'),
  voice('Sohee', '素熙'),
  voice('Eliška', '艾莉卡'),
  voice('Alek', '阿列克'),
  voice('Arda', '阿尔达'),
  voice('Dolce', '多尔切'),
  voice('Lenn', '莱恩'),
  voice('Ono Anna', '小野杏'),
  voice('Sonrisa', '索尼莎'),
  voice('Bodega', '博德加'),
  voice('Andre', '安德雷'),
  voice('Radio Gol', '拉迪奥·戈尔'),
  voice('Rizky', '阿力'),
  voice('Roya', '萝雅'),
  voice('Hana', '阿幸'),
  voice('Jakub', '雅克'),
  voice('Griet', '海娜'),
  voice('Marina', '玛丽娜'),
  voice('Siiri', '西芮'),
  voice('Ingrid', '林恩'),
  voice('Sigga', '海娜'),
  voice('Bea', '雅娜'),
  voice('Chloe', '思怡'),
  voice('Emilien', '埃米尔安'),
  voice('longanlingxin', '龙安灵心'),
]

/** Qwen3.5-Omni 音色：Qwen3.8 集合去掉 Zane/Cici/longanlingxin，补三个独有音色。 */
const QWEN35_OMNI_VOICES: RealtimeVoiceOption[] = [
  ...QWEN38_OMNI_VOICES.filter(
    (option) =>
      option.value !== 'Zane' && option.value !== 'Cici' && option.value !== 'longanlingxin'
  ),
  voice('Sunnybobi', '知芝'),
  voice('Ethan', '晨煦'),
  voice('Harvey', '厚'),
]

/** Qwen3-Omni 独有音色的中文显示名；共用音色沿用 Qwen3.8 列表的中文名。 */
const QWEN3_OMNI_ONLY_NAMES: Record<string, string> = {
  Cherry: '芊悦',
  Ethan: '晨煦',
  Nofish: '不吃鱼',
  Elias: '墨讲师',
  Jada: '上海-阿珍',
  Roy: '闽南-阿杰',
}

/** 旧 Qwen3-Omni 保留原协议与音色集合。 */
const QWEN3_OMNI_VOICES: RealtimeVoiceOption[] = [
  'Katerina',
  'Ryan',
  'Jennifer',
  'Sunny',
  'Dylan',
  'Eric',
  'Peter',
  'Marcus',
  'Li',
  'Rocky',
  'Kiki',
  'Ethan',
  'Cherry',
  'Nofish',
  'Elias',
  'Jada',
  'Roy',
].map((value) => {
  const shared = QWEN38_OMNI_VOICES.find((option) => option.value === value)
  if (shared) {
    return shared
  }
  const name = QWEN3_OMNI_ONLY_NAMES[value]
  return name ? voice(value, name) : { value, label: value }
})

/** Qwen3.8 使用新的 session.audio.output.voice 配置路径；Qwen3.5 及更早沿用 session.voice。 */
export const isQwen38OmniModel = (model: string | null): boolean =>
  model?.toLowerCase().includes('qwen3.8-omni') ?? false

const isQwen35OmniModel = (model: string | null): boolean =>
  model?.toLowerCase().includes('qwen3.5-omni') ?? false

/**
 * 未加载模型时先展示 Qwen3.8 选项；未知模型沿用旧集合并由建连时再次校正。
 */
const usesQwen38Voices = (model: string | null): boolean =>
  model === null || isQwen38OmniModel(model)

export const getRealtimeVoiceOptions = (model: string | null): RealtimeVoiceOption[] => {
  if (usesQwen38Voices(model)) {
    return QWEN38_OMNI_VOICES
  }
  if (isQwen35OmniModel(model)) {
    return QWEN35_OMNI_VOICES
  }
  return QWEN3_OMNI_VOICES
}

export const getDefaultRealtimeVoice = (model: string | null): string =>
  usesQwen38Voices(model) || isQwen35OmniModel(model) ? 'Tina' : 'Cherry'

/** 模型切换后若原音色不受支持，回退到该模型的文档默认音色。 */
export const resolveRealtimeVoice = (model: string | null, selected: string | null): string => {
  const options = getRealtimeVoiceOptions(model)
  if (selected && options.some((option) => option.value === selected)) {
    return selected
  }
  return getDefaultRealtimeVoice(model)
}
