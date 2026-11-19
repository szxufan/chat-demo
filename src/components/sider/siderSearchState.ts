import { create } from 'zustand'

/** 收起态搜索入口：请求展开侧边栏后聚焦搜索框，由 Sider 消费一次 */
export const useSiderSearchFocus = create(() => ({ pending: false }))

export const requestSiderSearchFocus = () => useSiderSearchFocus.setState({ pending: true })

/** 读取并清除聚焦请求；没有待处理请求时返回 false */
export const consumeSiderSearchFocus = () => {
  if (!useSiderSearchFocus.getState().pending) {
    return false
  }
  useSiderSearchFocus.setState({ pending: false })
  return true
}
