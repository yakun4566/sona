import { logger } from '@/index'
import { store } from '@/lib/store'
import { lcu, LcuEventUri } from '@/lib/lcu'
import type { ChampSelectSession } from '@/lib/lcu'
import { injector } from '@/lib/InjectorManager'
import { sonaNotify } from './notice'
type WatchState = {
  session: ChampSelectSession | null
  disabled: number[] | null
  pickable: number[] | null
  subset: number[] | null
}
type WatchKey = keyof WatchState
function getConfiguredChampionIds() {
  return [...new Set(store.get('autoLockChampionIds').filter(id => id > 0))]
}
let startAutoPick: ((run: number) => Promise<void>) | null = null
export let sonaAutoPickRun = 0
let sonaAutoPickPaused = false
let sonaAutoPickSelecting = false
let sonaStopBenchWatch: (() => void) | null = null
const sonaAutoPickPauseAttr = "data-sona-auto-pick-pause"
function sonaUpdatePauseButton(button: HTMLElement) {
  button.textContent = sonaAutoPickPaused ? "恢复秒抢" : "暂停秒抢"
  button.setAttribute("aria-label", sonaAutoPickPaused ? "恢复本局自动选择英雄" : "暂停本局自动选择英雄")
  button.setAttribute("aria-pressed", String(sonaAutoPickPaused))
  button.title = sonaAutoPickPaused ? "本局已暂停，点击恢复；下一局自动恢复" : "点击暂停本局秒抢，随后可手动选择任意英雄"
  button.style.color = sonaAutoPickPaused ? "#ffcc66" : "#f0e6d2"
}
function sonaMountPauseButton() {
  if (!sonaAutoPickSelecting || !store.get("autoLockChampion"))
    return false
  const container = document.querySelector(".bottom-right-buttons")
  if (!container)
    return false
  if (container.querySelector(`[${sonaAutoPickPauseAttr}]`))
    return true
  const button = document.createElement("lol-uikit-flat-button")
  button.setAttribute(sonaAutoPickPauseAttr, "true")
  button.style.cssText = "min-width:110px;margin-right:10px;flex-shrink:0;"
  sonaUpdatePauseButton(button)
  button.addEventListener("click", event => {
    event.preventDefault()
    event.stopPropagation()
    sonaToggleAutoPickPause()
  })
  container.insertBefore(button, container.firstChild)
  return true
}
function sonaToggleAutoPickPause() {
  if (!sonaAutoPickSelecting || !store.get("autoLockChampion"))
    return
  sonaAutoPickPaused = !sonaAutoPickPaused
  // Invalidate pending reads as well as the polling loop before changing UI state.
  const run = ++sonaAutoPickRun
  sonaStopBenchWatch?.()
  document.querySelectorAll<HTMLElement>(`[${sonaAutoPickPauseAttr}]`).forEach(sonaUpdatePauseButton)
  sonaNotify(sonaAutoPickPaused ? "本局秒抢已暂停，可手动选择英雄" : "本局秒抢已恢复")
  if (!sonaAutoPickPaused)
    void startAutoPick?.(run)
}
function sonaRemovePauseButton() {
  injector.unregister(sonaMountPauseButton)
  document.querySelectorAll(`[${sonaAutoPickPauseAttr}]`).forEach(button => button.remove())
}
export function sonaAutoPickActive(run: number) {
  return run === sonaAutoPickRun && store.get("autoLockChampion") && !sonaAutoPickPaused
}
export function sonaAutoPickRequest(run: number, path: string, options: RequestInit) {
  if (!sonaAutoPickActive(run))
    throw new Error("本局秒抢已暂停或任务已取消")
  return fetch(path, options)
}
function sonaBenchCandidates(session: ChampSelectSession, subset: number[] | null = null) {
  const priorities = getConfiguredChampionIds()
  const current = session.myTeam.find(player => player.cellId === session.localPlayerCellId)?.championId
  // Wait for the initially assigned hero before exchanging it.
  if (!current || current <= 0)
    return []
  const rank = priorities.indexOf(current)
  const bench = new Set(subset ?? (session.benchChampions || []).map(hero => hero.championId))
  return priorities.filter((id, index) => id !== current && bench.has(id) && (rank < 0 || index < rank))
}
export async function sonaWatchPriorityBench(run: number, initialSession: ChampSelectSession | null = null) {
  // Pengu's existing socket supplies snapshots; only missed events need polling.
  sonaStopBenchWatch?.()
  const retryAfter = new Map<number, number>(), subscriptions: (() => void)[] = [], revisions: Partial<Record<WatchKey, number>> = {}
  const state: WatchState = { session: initialSession, disabled: null, pickable: null, subset: null }
  const subsetUri = "/lol-lobby-team-builder/champ-select/v1/subset-champion-list"
  let stopped = false, dirty = false, refreshing = false, phaseReady = false, wake: (() => void) | null = null, timer: ReturnType<typeof setTimeout> | null = null
  let awaitingChampion = 0, confirmUntil = 0, refreshAt = 0
  const notify = () => { dirty = true; wake?.(); }
  const stop = () => {
    stopped = true
    clearTimeout(timer ?? undefined)
    subscriptions.splice(0).forEach(unsubscribe => unsubscribe())
    wake?.()
    if (sonaStopBenchWatch === stop)
      sonaStopBenchWatch = null
  }
  sonaStopBenchWatch = stop
  const active = () => !stopped && sonaAutoPickActive(run)
  const observe = (key: WatchKey, uri: string) => subscriptions.push(lcu.observe(uri, event => {
    revisions[key] = (revisions[key] || 0) + 1
    if (key === "session" && event.eventType === "Delete") {
      stop()
      return
    }
    Object.assign(state, { [key]: event.eventType === "Delete" ? null : event.data })
    notify()
  }))
  const load = async <K extends WatchKey>(key: K, get: () => Promise<WatchState[K]>) => {
    const revision = revisions[key] || 0
    try {
      const value = await get()
      // An event received during GET is newer than that GET's snapshot.
      if (active() && revision === (revisions[key] || 0)) {
        state[key] = value
        notify()
      }
    }
    catch {
      if (active() && revision === (revisions[key] || 0)) {
        state[key] = null
        notify()
      }
    }
  }
  try {
    observe("session", "/lol-champ-select/v1/session")
    observe("disabled", "/lol-champ-select/v1/disabled-champion-ids")
    observe("pickable", "/lol-champ-select/v1/pickable-champion-ids")
    observe("subset", subsetUri)
    while (active()) {
      if (!refreshing && Date.now() >= refreshAt) {
        refreshing = true
        refreshAt = Date.now() + 1000
        void Promise.all([
          lcu.getGameflowPhase().then(phase => {
            if (phase !== "ChampSelect")
              stop()
            else {
              phaseReady = true
              notify()
            }
          }).catch(stop),
          load("session", () => lcu.getChampSelectSession()),
          load("disabled", () => lcu.getDisabledChampionIds()),
          load("pickable", () => lcu.getPickableChampionIds()),
          ...(state.session?.allowSubsetChampionPicks ? [load("subset", async () => {
              const response = await fetch(subsetUri)
              if (!response.ok)
                throw new Error("初始英雄卡片尚未就绪")
              return response.json()
            })] : [])
        ]).finally(() => { refreshing = false; notify(); })
      }
      if (!active())
        break
      dirty = false
      const session = state.session
      if (session && !session.benchEnabled && !session.allowSubsetChampionPicks)
        break
      const current = session?.myTeam.find(player => player.cellId === session.localPlayerCellId)?.championId
      if (awaitingChampion && (current === awaitingChampion || Date.now() >= confirmUntil))
        awaitingChampion = 0
      if (phaseReady && session && !awaitingChampion && Array.isArray(state.disabled) && Array.isArray(state.pickable)) {
        const subsetPhase = session.allowSubsetChampionPicks && session.timer?.phase === "BAN_PICK"
        // Never choose from the full roster during the initial card-only phase.
        const subset = subsetPhase ? state.subset : null
        const action = subsetPhase && session.actions.flat(2).find(item => item.actorCellId === session.localPlayerCellId && item.type === "pick" && !item.completed && item.isInProgress)
        const candidates = subsetPhase && !Array.isArray(subset) ? [] : action
          ? getConfiguredChampionIds().filter(id => subset?.includes(id)) : session.benchEnabled ? sonaBenchCandidates(session, subset) : []
        const disabled = new Set(state.disabled), pickable = new Set(state.pickable)
        for (const target of candidates) {
          if (disabled.has(target) || !pickable.has(target) || (retryAfter.get(target) || 0) > Date.now())
            continue
          if (!active() || dirty)
            break
          try {
            if (action) {
              const response = await sonaAutoPickRequest(run, `/lol-champ-select/v1/session/actions/${action.id}`, {
                method: "PATCH", headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ type: "pick", championId: target, completed: true })
              })
              if (!response.ok)
                throw new Error(`选择卡片失败 (${response.status})`)
            }
            else {
              await lcu.benchSwap(target)
            }
            awaitingChampion = target
            confirmUntil = Date.now() + 2500
            logger.info("[AutoLock][ARAM] 已请求优先英雄 ID: %d", target)
            break
          }
          catch (error) {
            retryAfter.set(target, Date.now() + 250)
            logger.warn("[AutoLock][ARAM] 选择英雄 %d 失败，尝试下一候选: %o", target, error)
          }
        }
      }
      if (!active())
        break
      if (dirty)
        continue
      // Events wake immediately. Only errors/confirmation use a short recheck.
      const retrying = [...retryAfter.values()].some(until => until > Date.now())
      await new Promise<void>(resolve => {
        wake = () => { clearTimeout(timer ?? undefined); wake = null; resolve(); }
        timer = setTimeout(wake, Math.max(1, Math.min(refreshing ? 1000 : refreshAt - Date.now(), retrying || awaitingChampion ? 250 : 1000)))
      })
    }
  }
  finally {
    stop()
  }
}
let unsubscribeAutoPick: (() => void) | null = null
export function updateAutoPick(t: boolean, pick: (run: number) => Promise<void>) {
  startAutoPick = pick
  if (t && !unsubscribeAutoPick) {
    let inSelection = false
    const onPhase = (phase: string) => {
      if (phase === "ChampSelect") {
        if (inSelection)
          return
        inSelection = true
        sonaAutoPickSelecting = true
        sonaAutoPickPaused = false
        injector.register(sonaMountPauseButton)
        void startAutoPick?.(++sonaAutoPickRun)
      }
      else {
        inSelection = false
        sonaAutoPickSelecting = false
        sonaAutoPickPaused = false
        sonaAutoPickRun++
        sonaStopBenchWatch?.()
        sonaRemovePauseButton()
      }
    }
    unsubscribeAutoPick = lcu.observe(LcuEventUri.GAMEFLOW_PHASE_CHANGE, event => {
      if (typeof event.data === 'string')
        onPhase(event.data)
    })
    const initialRun = sonaAutoPickRun
    lcu.getGameflowPhase().then(phase => {
      if (unsubscribeAutoPick && initialRun === sonaAutoPickRun)
        onPhase(phase)
    }).catch(error => logger.warn("[AutoLock] 无法读取初始选人阶段: %o", error))
    logger.info("Auto lock champion enabled (includes ARAM bench) ✓")
  }
  else if (!t && unsubscribeAutoPick) {
    unsubscribeAutoPick()
    unsubscribeAutoPick = null
    sonaAutoPickRun++
    sonaStopBenchWatch?.()
    sonaAutoPickSelecting = false
    sonaAutoPickPaused = false
    sonaRemovePauseButton()
    logger.info("Auto lock champion disabled")
  }
}
