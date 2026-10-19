import { logger } from '@/index'
import { store } from '@/lib/store'
import { lcu, LcuEventUri } from '@/lib/lcu'
import type { Lobby, ChatConversation } from '@/types/lcu'
import { getChampionById } from '@/lib/assets'
import { translate } from '@/i18n'
import { sonaNotify } from './notice'
import type { TeammateStats, TeamStatsResult, TeamStatsSession } from '@/lib/features'
import type {} from './chat-types'
interface AnalysisDependencies {
  fetchTeamStats(): Promise<TeamStatsResult>
  queryTeamStats(session: TeamStatsSession): Promise<TeamStatsResult>
  assignTitles(stats: TeammateStats[]): Map<string, string>
  playerKey(stat: TeammateStats): string
}
export function createManualAnalysis(deps: AnalysisDependencies) {
  let sonaAnalysisCache: {
    text: string
    round: number
  } | null = null
  let sonaAnalysisPending: Promise<{
    text: string
    round: number
  }> | null = null
  let sonaAnalysisRevision = 0
  let previousPhase: string | null = null
  function sonaAnalysisChatLabel(player: Pick<TeammateStats, "floor" | "gameName">) {
    const name = String(player.gameName || "").replace(/[\r\n\t]/g, " ").trim()
    const chars = Array.from(name)
    const shortName = chars.length > 8 ? chars.slice(0, 8).join("") + "…" : name
    const floor = translate("champSelect.teamAnalysis.floor", { floor: player.floor })
    return `[${floor}]${shortName ? ` ${shortName}` : ""}`
  }
  function sonaAnalysisPlainTier(tier: string) {
    return tier.replace(/^[^A-Za-z\u3400-\u9fff]+/u, "")
  }
  async function sonaQueryEnemyAnalysis() {
    if (!store.get("analyzeTeamPower"))
      throw new Error("请先开启 Sona 的分析友方战力")
    const allowed = (phase: string) => ["GameStart", "InProgress", "Reconnect"].includes(phase)
    if (!allowed(await lcu.getGameflowPhase()))
      throw new Error("请在进入本局游戏后查询敌方")
    const game = await lcu.getGameflowSession(), self = await lcu.getSummonerInfo()
    const data = game.gameData
    if (!data?.gameId)
      throw new Error("本局游戏标识尚未就绪")
    const teams = [data.teamOne || [], data.teamTwo || []]
    const ownTeam = teams.findIndex(team => team.some(player => (self.puuid && player.puuid === self.puuid) || (self.summonerId && player.summonerId === self.summonerId)))
    if (ownTeam < 0)
      throw new Error("暂时无法确认己方队伍，请稍后重试")
    const enemies = teams[1 - ownTeam]
    if (!enemies.length)
      throw new Error("敌方身份尚未就绪，请稍后再按 F7")
    const players = await Promise.all(enemies.map(async (player, cellId) => {
      const info = !player.puuid && player.summonerId ? await lcu.getSummonerById(player.summonerId).catch(() => null) : null
      return { ...player, ...info, puuid: player.puuid || info?.puuid || "", cellId }
    }))
    const { stats } = await deps.queryTeamStats({ myTeam: players, localPlayerCellId: 0, queueId: data.queue?.id || 0 })
    if (!store.get("analyzeTeamPower") || !allowed(await lcu.getGameflowPhase()) || String((await lcu.getGameflowSession()).gameData?.gameId) !== String(data.gameId))
      throw new Error("对局已结束或更换，已取消敌方查询")
    const ranked = deps.assignTitles(stats)
    return players.map((player, index) => {
      const stat = stats.find(item => player.puuid && item.puuid === player.puuid)
      const selection = data.playerChampionSelections?.find(item => item.puuid && item.puuid === player.puuid)
      const champion = getChampionById(player.championId || selection?.championId || 0)
      const name = String(stat?.gameName || player.gameName || player.summonerName || `玩家${index + 1}`).replace(/[\r\n\t]/g, " ")
      const prefix = `[敌方]${champion ? ` ${champion.name}` : ""} ${name}`
      if (stat?.winRate == null)
        return `${prefix}：暂无有效战绩 / 查询失败`
      const tier = sonaAnalysisPlainTier(ranked.get(deps.playerKey(stat)) || translate("strength.teamTier.newbie"))
      return `${prefix}：${tier} | 胜率${stat.winRate.toFixed(1)}% | KDA${stat.kdaNum >= 99 ? "Perfect" : stat.kdaNum.toFixed(2)} | 评分${stat.strengthScore ? stat.strengthScore.score.toFixed(1) : "--"}`
    }).join("\n")
  }
  async function saveAnalysis(round: number, revision: number) {
    const bridge = window.__SONA_CHAT_BRIDGE__
    if (!bridge)
      throw new Error("桥接插件尚未就绪")
    const { stats } = await deps.fetchTeamStats()
    if (!store.get("analyzeTeamPower") || revision !== sonaAnalysisRevision)
      throw new Error("本次分析已取消")
    logger.info("┌─── 队友战绩分析 ───")
    const chatLines = [], exported = [], titles = deps.assignTitles(stats)
    for (const player of stats) {
      const floor = translate("champSelect.teamAnalysis.floor", { floor: player.floor })
      const name = String(player.gameName || "").replace(/[\r\n\t]/g, " ").trim()
      const tag = String(player.tagLine || "").replace(/[\r\n\t]/g, " ").trim()
      const label = name ? `${name}${tag ? `#${tag}` : ""} (${floor})` : floor
      if (player.winRate == null) {
        logger.info("│ %s — %s#%s — 无近期战绩或查询失败", label, player.gameName, player.tagLine)
        chatLines.push(translate("champSelect.teamAnalysis.emptyLine", { floor: sonaAnalysisChatLabel(player) }))
        exported.push(`${label}：暂无有效战绩 / 查询失败`)
        continue
      }
      const winRate = player.winRate.toFixed(1), kda = player.kdaNum >= 99 ? "Perfect" : player.kdaNum.toFixed(2), title = titles.get(deps.playerKey(player)) ?? translate("strength.teamTier.newbie"), score = player.strengthScore ? player.strengthScore.score.toFixed(1) : "--"
      logger.info("│ %s — %s#%s — 近%d场 胜率: %s%% (%d胜%d负) | KDA: %s (%.1f/%.1f/%.1f) | 综合评分: %s | %s", label, player.gameName, player.tagLine, player.total, winRate, player.wins, player.total - player.wins, kda, player.avgK, player.avgD, player.avgA, score, title)
      const tier = sonaAnalysisPlainTier(title)
      chatLines.push(translate("champSelect.teamAnalysis.line", { floor: sonaAnalysisChatLabel(player), title: tier, winRate, kda, score }))
      exported.push(`${label}：${tier} | 胜率${winRate}% | KDA${kda} | 评分${score}`)
    }
    logger.info("└────────────────────")
    if (!chatLines.length)
      throw new Error("未获取到队友信息，将自动重试。")
    const text = "牛马检测\n" + chatLines.join("\n\n")
    await bridge.save(exported.join("\n"), round)
    if (!store.get("analyzeTeamPower") || revision !== sonaAnalysisRevision)
      throw new Error("本次分析已取消")
    sonaAnalysisCache = { text, round }
    sonaNotify("分析已自动保存，按 F8 发送")
    return sonaAnalysisCache
  }
  async function sonaEnsureAnalysis() {
    if (!store.get("analyzeTeamPower"))
      throw new Error("请先开启分析友方战力")
    const bridge = window.__SONA_CHAT_BRIDGE__
    if (!bridge)
      throw new Error("未加载 sona-chat-bridge 文件夹插件，请检查安装并重启客户端。")
    const round = await bridge.begin()
    if (sonaAnalysisCache?.round === round)
      return sonaAnalysisCache
    if (sonaAnalysisPending)
      return sonaAnalysisPending
    const pending = saveAnalysis(round, sonaAnalysisRevision)
    sonaAnalysisPending = pending
    try {
      return await pending
    }
    finally {
      if (sonaAnalysisPending === pending)
        sonaAnalysisPending = null
    }
  }
  let unsubscribeAnalysis: (() => void) | null = null
  let sonaManualAnalysisBusy = false
  function sonaLobbyAnalysisMembers(lobby: Lobby) {
    const teamId = lobby.localMember?.teamId
    return (lobby.members || []).filter(member => !member.isBot && !member.isSpectator && (!(teamId > 0) || member.teamId === teamId))
  }
  function sonaLobbyAnalysisKey(lobby: Lobby) {
    return JSON.stringify([lobby.partyId || "", lobby.multiUserChatId || "", lobby.gameConfig?.queueId || 0,
      sonaLobbyAnalysisMembers(lobby).map(member => `${member.puuid || member.summonerId}:${member.teamId || 0}`).sort()])
  }
  function sonaResolveLobbyConversation(lobby: Lobby, conversations: ChatConversation[]) {
    const roomId = String(lobby.multiUserChatId || "")
    if (!roomId)
      return null
    const roomKey = roomId.split("@")[0]
    return conversations.find(conversation => conversation.id === roomId) ||
      conversations.find(conversation => conversation.type !== "chat" && String(conversation.id).split("@")[0] === roomKey) || null
  }
  async function sonaQueryLobbyAnalysis() {
    const revision = sonaAnalysisRevision
    const lobby = await lcu.getLobby(), key = sonaLobbyAnalysisKey(lobby)
    const members = sonaLobbyAnalysisMembers(lobby)
    if (!members.length)
      throw new Error("组队房间没有可查询的玩家")
    sonaNotify("正在查询组队成员战绩…")
    const players = await Promise.all(members.map(async (member, cellId) => {
      const info = !member.puuid && member.summonerId ? await lcu.getSummonerById(member.summonerId).catch(() => null) : null
      return { ...member, ...info, puuid: member.puuid || info?.puuid || "", cellId }
    }))
    const queueId = Number(lobby.gameConfig?.queueId) || 0
    const analysis = await deps.queryTeamStats({ myTeam: players, localPlayerCellId: 0, queueId })
    if (!store.get("analyzeTeamPower") || revision !== sonaAnalysisRevision || await lcu.getGameflowPhase() !== "Lobby")
      return
    if (sonaLobbyAnalysisKey(await lcu.getLobby()) !== key)
      throw new Error("房间成员或模式已变化，请重新按 F8 查询")
    const stats = players.map((player, index) => {
      const stat = analysis.stats.find(item => player.puuid && item.puuid === player.puuid)
      return { ...(stat || { winRate: null, puuid: player.puuid, summonerId: player.summonerId || 0,
          obfuscatedPuuid: '', obfuscatedSummonerId: 0, tagLine: '', wins: 0, total: 0,
          avgK: 0, avgD: 0, avgA: 0, kdaNum: 0, strengthScore: null }), floor: index + 1,
        gameName: stat?.gameName || player.gameName || player.summonerName || `成员${index + 1}` }
    })
    const tiers = deps.assignTitles(stats)
    const lines = [queueId > 0 ? `当前队列 ${queueId} 的近期战绩` : "近期全部模式战绩（房间未指定有效队列）"]
    for (const player of stats) {
      const label = sonaAnalysisChatLabel(player)
      lines.push(player.winRate == null ? translate("champSelect.teamAnalysis.emptyLine", { floor: label }) :
        translate("champSelect.teamAnalysis.line", { floor: label,
          title: sonaAnalysisPlainTier(tiers.get(deps.playerKey(player)) || translate("strength.teamTier.newbie")),
          winRate: player.winRate.toFixed(1), kda: player.kdaNum >= 99 ? "Perfect" : player.kdaNum.toFixed(2),
          score: player.strengthScore ? player.strengthScore.score.toFixed(1) : "--" }))
    }
    const conversations = await lcu.getChatConversations()
    if (!store.get("analyzeTeamPower") || revision !== sonaAnalysisRevision || await lcu.getGameflowPhase() !== "Lobby")
      return
    const currentLobby = await lcu.getLobby()
    if (sonaLobbyAnalysisKey(currentLobby) !== key)
      throw new Error("房间成员或模式已变化，请重新按 F8 查询")
    const conversation = sonaResolveLobbyConversation(currentLobby, conversations)
    if (!conversation)
      throw new Error("当前房间聊天尚未就绪，请展开房间聊天后再按 F8")
    await lcu.sendChatMessage(conversation.id, { body: "牛马检测\n" + lines.join("\n\n"), type: store.get("analyzeTeamPowerMsgType") || "celebration" })
    sonaNotify("队友分析已发送到组队房间聊天")
  }
  async function sonaManualAnalysisKey(event: KeyboardEvent) {
    if (event.key !== "F8" || event.repeat || event.ctrlKey || event.altKey || event.shiftKey || event.metaKey)
      return
    event.preventDefault()
    if (sonaManualAnalysisBusy)
      return
    sonaManualAnalysisBusy = true
    try {
      const phase = await lcu.getGameflowPhase()
      if (phase === "Lobby") {
        await sonaQueryLobbyAnalysis()
        return
      }
      if (phase !== "ChampSelect")
        return
      const analysis = await sonaEnsureAnalysis()
      if (!store.get("analyzeTeamPower"))
        return
      await window.__SONA_CHAT_BRIDGE__!.check(analysis.round)
      await lcu.sendChampSelectMessage(analysis.text, store.get("analyzeTeamPowerMsgType") || "celebration")
      sonaNotify("队友分析已发送到选人聊天框")
    }
    catch (error) {
      sonaNotify(`查询或发送失败：${(error instanceof Error ? error.message : String(error)) || error}`, true)
    }
    finally {
      sonaManualAnalysisBusy = false
    }
  }
  function updateManualAnalysis(t: boolean) {
    if (t && !unsubscribeAnalysis) {
      let lastError = ""
      const prepare = async () => {
        try {
          const phase = await lcu.getGameflowPhase()
          if (phase !== "ChampSelect")
            return
          if (previousPhase === null) previousPhase = phase
          await sonaEnsureAnalysis()
          lastError = ""
        }
        catch (error) {
          logger.error("队友分析自动保存失败:", error)
          if (lastError !== (error instanceof Error ? error.message : String(error)))
            sonaNotify(`自动保存未完成：${(error instanceof Error ? error.message : String(error))}`, true)
          lastError = (error instanceof Error ? error.message : String(error))
        }
      }
      const unsubscribe = lcu.observe(LcuEventUri.GAMEFLOW_PHASE_CHANGE, event => {
        if (typeof event.data !== 'string')
          return
        if (event.data === previousPhase)
          return
        previousPhase = event.data
        sonaAnalysisRevision++
        sonaAnalysisCache = null
        sonaAnalysisPending = null
        if (event.data === "ChampSelect")
          void prepare()
      })
      const timer = setInterval(prepare, 2000)
      document.addEventListener("keydown", sonaManualAnalysisKey, true)
      unsubscribeAnalysis = () => {
        unsubscribe()
        previousPhase = null
        sonaAnalysisPending = null
        if (window.__SONA_QUERY_ENEMIES__ === sonaQueryEnemyAnalysis)
          delete window.__SONA_QUERY_ENEMIES__
        clearInterval(timer)
        document.removeEventListener("keydown", sonaManualAnalysisKey, true)
        sonaAnalysisRevision++
        sonaAnalysisCache = null
      }
      window.__SONA_QUERY_ENEMIES__ = sonaQueryEnemyAnalysis
      void prepare()
      logger.info("队友分析已启用：自动保存，选人阶段按 F8 发送")
    }
    else if (!t && unsubscribeAnalysis) {
      unsubscribeAnalysis()
      unsubscribeAnalysis = null
      logger.info("队友分析快捷键已关闭")
    }
  }
  return { updateManualAnalysis, sonaQueryEnemyAnalysis }
}
