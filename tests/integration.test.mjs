import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { loadScript, loadDeclarations, loadClassMethod } from './source-loader.mjs'

function runeFixture(pages) {
  const values = new Map(), writes = [], deleted = []
  const manager = vm.runInNewContext(loadScript('src/lib/custom/rune-page-ownership.ts') + '\n' +
    loadClassMethod('src/lib/lcu.ts', 'LCUManager', 'applyRunePage') + '\nnew TestManager()', {
    DataStore: { get: key => values.get(key), set: (key, value) => { values.set(key, value); return true } },
  })
  Object.assign(manager, {
    getRunePages: async () => pages,
    updateRunePage: async (id, page) => { writes.push(id); Object.assign(pages.find(item => item.id === id), page); return { id, ...page } },
    deleteRunePage: async id => deleted.push(id),
    createRunePage: async page => { const result = { id: 100, ...page }; pages.push(result); return result },
  })
  return { manager, writes, deleted }
}

test('clean rune names reuse the recorded page across champions and retain unrelated pages', async () => {
  const f = runeFixture([{ id: 9, name: '我的自建符文', isEditable: true }])
  const first = await f.manager.applyRunePage({ name: '亚索 大乱斗' })
  const second = await f.manager.applyRunePage({ name: '拉克丝 大乱斗' })
  assert.equal(first.id, 100)
  assert.equal(second.id, 100)
  assert.deepEqual(f.writes, [100])
  assert.deepEqual(f.deleted, [])
})

test('legacy branded rune page migrates to the clean name and keeps upstream duplicate cleanup', async () => {
  const f = runeFixture([{ id: 1, name: '旧英雄 - Sona' }, { id: 2, name: '其他旧英雄 - Sona' }, { id: 3, name: '自建符文' }])
  const page = await f.manager.applyRunePage({ name: '新英雄 大乱斗' })
  assert.equal(page.id, 1)
  assert.deepEqual(f.deleted, [2])
})

const queryCode = loadDeclarations('src/lib/features.ts', ['resolveChampSelectPuuid', '_doFetchTeamStats', 'getAnalyzableTeamPlayers'])

function queryFixture() {
  const calls = []
  const query = vm.runInNewContext(queryCode + '\n_doFetchTeamStats', {
    lcu: {
      getChampSelectSession: async () => { throw new Error('explicit player queries must not read champion select') },
      getSummonerByPuuid: async puuid => ({ summonerId: 7, gameName: '玩家' + puuid, tagLine: 'CN1' }),
      getSgpMatchHistory: async (puuid, options) => {
        calls.push([puuid, options])
        return { games: [{ json: { participants: [{ puuid, kills: 6, deaths: 2, assists: 8, win: true }] } }] }
      },
    },
    logger: { info() {}, warn() {} }, store: { get: () => 50 },
    queueIdToTag: queue => queue > 0 ? String(queue) : '',
    filterSonaStrengthGamesByQueue: games => games,
    shouldSkipSonaStrengthGame: () => false,
    calculateSonaPlayerStrengthScore: () => ({ score: 12 }),
    deobfuscateChampSelectPuuid: id => 'resolved-' + id,
  })
  return { query, calls }
}

test('shared query accepts lobby/game players and preserves queue filtering, identity backfill and scoring', async () => {
  const f = queryFixture()
  const result = await f.query({ myTeam: [{ puuid: 'p1', cellId: 0 }], localPlayerCellId: 0, queueId: 450 })
  assert.equal(result.stats[0].gameName, '玩家p1')
  assert.equal(result.stats[0].kdaNum, 7)
  assert.equal(result.stats[0].strengthScore.score, 12)
  assert.equal(f.calls[0][1].tag, '450')
})

test('shared query retains hidden-player resolution and leaves queue zero unfiltered', async () => {
  const f = queryFixture()
  await f.query({ myTeam: [{ puuid: '', obfuscatedPuuid: 'hidden', nameVisibilityType: 'HIDDEN', cellId: 0 }], localPlayerCellId: 0, queueId: 0 })
  assert.equal(f.calls[0][0], 'resolved-hidden')
  assert.equal(f.calls[0][1].tag, undefined)
})

const requestCode = loadDeclarations('src/lib/features.ts', ['fetchTeamStats', 'getPlayerStatsKey'])
const settle = () => new Promise(setImmediate)

test('same-round requests share work; a late old-round response cannot clear or join a new-round request', async () => {
  let gameId = 1
  const requests = []
  const fetchStats = vm.runInNewContext('let _fetchTeamStatsPromise = null; let _fetchTeamStatsKey = "";\n' + requestCode + '\nfetchTeamStats', {
    lcu: { getChampSelectSession: async () => ({ gameId, queueId: 450, chatDetails: { multiUserChatId: 'room-' + gameId }, myTeam: [{ puuid: 'p1', cellId: 0 }] }) },
    _doFetchTeamStats: session => new Promise(resolve => requests.push({ gameId: session.gameId, resolve })),
  })
  const first = fetchStats(), sameRound = fetchStats()
  await settle()
  assert.equal(requests.length, 1)
  gameId = 2
  const nextRound = fetchStats()
  await settle()
  assert.equal(requests.length, 2)
  requests[0].resolve('old-round')
  assert.deepEqual(await Promise.all([first, sameRound]), ['old-round', 'old-round'])
  const sameNewRound = fetchStats()
  await settle()
  assert.equal(requests.length, 2)
  requests[1].resolve('new-round')
  assert.deepEqual(await Promise.all([nextRound, sameNewRound]), ['new-round', 'new-round'])
})
