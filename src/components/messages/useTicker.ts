import { useEffect, useState } from 'react'

/** 进行中时按间隔刷新，用于耗时与轮播等需要随时间变化的展示 */
export const useTicker = (active: boolean, interval: number) => {
  const [tick, setTick] = useState(0)
  useEffect(() => {
    if (!active) {
      return
    }
    const timer = setInterval(() => setTick((value) => value + 1), interval)
    return () => clearInterval(timer)
  }, [active, interval])
  return tick
}
