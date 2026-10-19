import { useEffect, useRef, useState } from 'react'
import { getAllChampions, getChampionById, searchChampions, type ChampionInfo } from '@/lib/assets'
import { store } from '@/lib/store'
import { useI18n } from '@/i18n'
import { SonaInput } from './SonaInput'
import { SonaButton } from './SonaButton'
import '@/styles/AutoPick.css'

export function AutoPickQueue() {
  const { t } = useI18n()
  const [ids, setIds] = useState(store.get('autoLockChampionIds'))
  const [instant, setInstant] = useState(store.get('autoLockInstant'))
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState(false)
  const [expanded, setExpanded] = useState(true)
  const [dropTarget, setDropTarget] = useState<number | null>(null)
  const draggedHero = useRef<number | null>(null)
  const selector = useRef<HTMLDivElement>(null)
  const options = (query.trim() ? searchChampions(query, Infinity) : getAllChampions().sort((a, b) => a.name.localeCompare(b.name, 'zh-CN')))
    .filter(hero => !/^Jade_/i.test(hero.alias || ''))

  useEffect(() => {
    const unsubscribeIds = store.onChange('autoLockChampionIds', setIds)
    const unsubscribeInstant = store.onChange('autoLockInstant', setInstant)
    const closeOutside = (event: MouseEvent) => {
      if (selector.current && !selector.current.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', closeOutside)
    return () => {
      unsubscribeIds()
      unsubscribeInstant()
      document.removeEventListener('mousedown', closeOutside)
    }
  }, [])

  const save = (next: number[]) => { setIds(next); store.set('autoLockChampionIds', next) }
  const add = (hero: ChampionInfo) => {
    if (!ids.includes(hero.id)) save([...ids, hero.id])
    setOpen(true)
  }
  const reorder = (target: number) => {
    const source = draggedHero.current
    if (source !== null && source !== target && ids.includes(source)) {
      const next = ids.filter(id => id !== source)
      next.splice(ids.indexOf(target), 0, source)
      save(next)
    }
    draggedHero.current = null
    setDropTarget(null)
  }

  return (
    <div style={{ padding: '0 12px 12px', display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div className="sona-debug-actions" style={{ alignItems: 'flex-start', gap: 8 }}>
        <div className="sona-auto-pick-select" ref={selector} style={{ flex: 1, position: 'relative' }}
          onFocusCapture={event => { if ((event.target as HTMLElement).tagName === 'INPUT') setOpen(true) }}>
          <SonaInput value={query} onChange={value => { setQuery(value); setOpen(true) }}
            placeholder={t('tools.autoLock.searchPlaceholder')}
            onKeyDown={event => {
              if (event.nativeEvent.isComposing) return
              if (event.key === 'Escape') { event.preventDefault(); setOpen(false) }
              if (event.key === 'ArrowDown') {
                event.preventDefault()
                setOpen(true)
                requestAnimationFrame(() => selector.current?.querySelector<HTMLButtonElement>('[role="option"]:not(:disabled)')?.focus())
              }
              if (event.key === 'Enter' && open) {
                const hero = options.find(item => !ids.includes(item.id))
                if (hero) { event.preventDefault(); add(hero) }
              }
            }} />
          <button type="button" className="sona-auto-pick-toggle" aria-label="展开或收起英雄列表" aria-expanded={open}
            onMouseDown={event => event.preventDefault()} onClick={() => setOpen(!open)}>{open ? '▴' : '▾'}</button>
          {open && <div className="sona-champ-suggest" role="listbox" aria-label="选择要加入秒抢队列的英雄">
            {options.length ? options.map(hero => <button key={hero.id} type="button" role="option"
              className="sona-champ-suggest-item sona-auto-pick-option" aria-selected={ids.includes(hero.id)} disabled={ids.includes(hero.id)}
              onKeyDown={event => {
                if (event.key === 'Escape') {
                  event.preventDefault()
                  selector.current?.querySelector('input')?.focus()
                  setOpen(false)
                }
              }} onClick={() => add(hero)}>
              <img className="sona-champ-suggest-icon" src={`/lol-game-data/assets/v1/champion-icons/${hero.id}.png`} alt="" />
              <span className="sona-champ-suggest-title">{hero.title}</span>
              <span className="sona-champ-suggest-name">{hero.name}</span>
              {ids.includes(hero.id) && <span className="sona-auto-pick-added">已添加</span>}
            </button>) : <div className="sona-auto-pick-empty">没有匹配的英雄</div>}
          </div>}
        </div>
        <SonaButton variant={instant ? 'primary' : undefined} onClick={() => store.set('autoLockInstant', true)}>
          {t('tools.autoLock.lock')}{instant ? ' ✓' : ''}
        </SonaButton>
        <SonaButton variant={!instant ? 'primary' : undefined} onClick={() => store.set('autoLockInstant', false)}>
          {t('tools.autoLock.preselect')}{!instant ? ' ✓' : ''}
        </SonaButton>
        <button type="button" className="sona-btn sona-btn--secondary" style={{ width: 36, minWidth: 36, padding: '8px 0', flexShrink: 0 }}
          title={expanded ? '收起已选英雄' : `展开已选英雄 (${ids.length})`} aria-label={expanded ? '收起已选英雄' : '展开已选英雄'}
          aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>{expanded ? '▴' : '▾'}</button>
      </div>
      {expanded && (ids.length ? <div className="sona-champ-priority-list sona-auto-pick-grid">
        {ids.map((id, index) => {
          const hero = getChampionById(id)
          return <div key={id} draggable
            className={`sona-champ-priority-card sona-champ-priority-draggable${dropTarget === id ? ' sona-champ-priority-drop-target' : ''}`}
            onDragStart={event => { draggedHero.current = id; event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', String(id)) }}
            onDragOver={event => { if (draggedHero.current !== null) { event.preventDefault(); setDropTarget(id) } }}
            onDrop={event => { event.preventDefault(); reorder(id) }}
            onDragEnd={() => { draggedHero.current = null; setDropTarget(null) }}>
            <span className="sona-champ-priority-index">{index + 1}</span>
            <img className="sona-champ-priority-icon" draggable={false} src={`/lol-game-data/assets/v1/champion-icons/${id}.png`} alt="" />
            <span className="sona-champ-priority-name">{hero ? `${hero.title} ${hero.name}` : `英雄#${id}`}</span>
            <button className="sona-champ-priority-remove" type="button" aria-label="移除" onClick={() => save(ids.filter(item => item !== id))}>×</button>
          </div>
        })}
      </div> : <p className="sona-subtitle" style={{ margin: 0 }}>{t('tools.autoLock.empty')}</p>)}
    </div>
  )
}
