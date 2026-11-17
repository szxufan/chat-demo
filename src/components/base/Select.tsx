import clsx from 'clsx'
import { useState } from 'react'
import { createPortal } from 'react-dom'
import { useAnchoredPosition, useDismiss } from './anchored.js'
import { IconCheckOutline16, IconChevronDownOutline14 } from './icons.js'
import styles from './Select.module.css'

export type SelectOption<T extends string> = {
  value: T
  label: string
  lang?: string
  /** 选项内的次要说明文字，显示在 label 下方 */
  description?: string
}

/**
 * 胶囊形选择器：触发器高 36px、圆角 18px、浅灰底，下拉菜单选中项右侧打勾；
 * 点外部或 Esc 关闭。value 不匹配任何选项时触发器显示 placeholder。
 * searchable 时菜单顶部带筛选输入框，按 label 子串过滤，Enter 选中首个匹配项。
 */
export const Select = <T extends string>({
  value,
  options,
  onChange,
  placeholder,
  ariaLabel,
  className,
  disabled = false,
  searchable = false,
  searchPlaceholder,
  noMatchText,
}: {
  value: T
  options: SelectOption<T>[]
  onChange: (value: T) => void
  placeholder?: string
  ariaLabel?: string
  className?: string
  disabled?: boolean
  searchable?: boolean
  searchPlaceholder?: string
  noMatchText?: string
}) => {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const current = options.find((option) => option.value === value)
  const keyword = query.trim().toLowerCase()
  const visible =
    searchable && keyword
      ? options.filter((option) => option.label.toLowerCase().includes(keyword))
      : options
  const close = () => {
    setOpen(false)
    setQuery('')
  }
  const choose = (next: T) => {
    close()
    onChange(next)
  }
  // 菜单贴右侧展开，最多 320px 高，超出在菜单内滚动
  const { anchorRef, floatingRef, position } = useAnchoredPosition<
    HTMLButtonElement,
    HTMLDivElement
  >(open, { align: 'end', maxHeight: 320, minSpace: 160 })
  // Esc 只关菜单，不让外层弹窗一起关闭
  useDismiss(open, [anchorRef, floatingRef], close, { captureEscape: true })

  return (
    <>
      <button
        ref={anchorRef}
        type="button"
        className={clsx(styles.trigger, open && styles.open, className)}
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => (open ? close() : setOpen(true))}
      >
        {current ? (
          <span lang={current.lang}>{current.label}</span>
        ) : (
          <span className={styles.placeholder}>{placeholder}</span>
        )}
        <span className={styles.arrow}>
          <IconChevronDownOutline14 />
        </span>
      </button>
      {open && !disabled
        ? createPortal(
            <div
              ref={floatingRef}
              className={styles.menu}
              style={position ?? undefined}
            >
              {searchable ? (
                <input
                  type="text"
                  role="searchbox"
                  className={styles.search}
                  aria-label={searchPlaceholder}
                  placeholder={searchPlaceholder}
                  value={query}
                  autoFocus
                  onChange={(event) => setQuery(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' && visible.length > 0) {
                      event.preventDefault()
                      choose(visible[0].value)
                    }
                  }}
                />
              ) : null}
              <div className={styles.menuList} role="listbox" aria-label={ariaLabel}>
                {visible.map((option) => (
                  <div
                    key={option.value}
                    role="option"
                    lang={option.lang}
                    aria-selected={option.value === value}
                    className={styles.option}
                    onClick={() => choose(option.value)}
                  >
                    <span className={styles.optionText}>
                      <span>{option.label}</span>
                      {option.description ? (
                        <span className={styles.optionDescription}>{option.description}</span>
                      ) : null}
                    </span>
                    {option.value === value ? <IconCheckOutline16 /> : null}
                  </div>
                ))}
                {visible.length === 0 ? (
                  <div className={styles.empty}>{noMatchText}</div>
                ) : null}
              </div>
            </div>,
            document.body
          )
        : null}
    </>
  )
}