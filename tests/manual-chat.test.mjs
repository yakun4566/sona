import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const bridgeSource = fs.readFileSync(new URL('../sona-chat-bridge/index.js', import.meta.url), 'utf8');
import { loadScript, compileScript } from './source-loader.mjs';
const features = fs.readFileSync(new URL('../src/lib/features.ts', import.meta.url), 'utf8');
const ranking = features.slice(features.indexOf('const TEAM_POWER_TITLE_KEYS'), features.indexOf('const { updateManualAnalysis:'));
const sonaSource = loadScript('src/lib/custom/manual-analysis.ts');
const localeSource = loadScript('src/i18n/locales.ts');
const zhCN = vm.runInNewContext(localeSource + '\nzhCN');
const settle = async () => { for (let i = 0; i < 4; i++) await new Promise(setImmediate); };

function bridgeFixture() {
  let phase = 'ChampSelect', id = 'round-1', text = '', writable = true, poll;
  let request = '', enemyCalls = 0, enemyHandler = async () => '[敌方] 测试玩家：上等马';
  const values = new Map();
  const window = {
    DataStore: {
      set: (key, value) => { if (!writable) return false; values.set(key, value); return true; },
      get: key => values.get(key)
    },
    __SONA_QUERY_ENEMIES__: async () => { enemyCalls++; return enemyHandler(); },
    fetch: async path => path.includes('enemy-request.txt') ? { ok: !!request, text: async () => request } :
      { ok: true, json: async () => path.includes('gameflow') ? phase : [{ type: 'championSelect', id }] },
    addEventListener() {}
  };
  // Match 1.1.6: context.fs does not exist.
  const context = {};
  vm.runInNewContext(bridgeSource.replace('export function init', 'function init').replaceAll('import.meta.url', '"https://plugins/sona-chat-bridge/index.js"') + '\ninit(context);', {
    window, context, TextEncoder, btoa, URL, console: { info() {}, debug() {}, error() {} },
    setInterval(fn) { poll = fn; return 1; }, clearInterval() {}
  });
  return { api: window.__SONA_CHAT_BRIDGE__, poll: () => poll(),
    text: () => { const value = values.get('sona-chat-bridge.export.v1'); return value ? Buffer.from(value, 'base64').toString('utf8').slice(15) : ''; },
    enemy: () => { const value = values.get('sona-chat-bridge.enemy.v1'); return value ? Buffer.from(value, 'base64').toString('utf8').slice(15) : ''; },
    request(value) { request = value; }, enemyCalls: () => enemyCalls,
    enemyHandler(fn) { enemyHandler = fn; },
    phase(value) { phase = value; }, id(value) { id = value; }, failWrite() { writable = false; } };
}

test('saved text survives game start and clears on cancellation or new round', async () => {
  const f = bridgeFixture();
  const round = await f.api.begin();
  assert.equal(f.text(), '');
  const text = '玩家甲#CN1: 上等马|胜率60%|KDA4.2\n玩家乙: 萌新上线';
  await f.api.save(text, round);
  f.phase('GameStart'); await f.poll();
  f.phase('InProgress'); await f.poll();
  assert.equal(f.text(), text);
  await assert.rejects(f.api.save('too late', round), /选人阶段已结束/);
  f.phase('Lobby'); await f.poll();
  assert.equal(f.text(), '');
  f.phase('ChampSelect'); f.id('round-2');
  const next = await f.api.begin();
  assert.notEqual(next, round);
  await assert.rejects(f.api.save('stale', round), /对局已更换/);
  await f.api.save('new round', next);
  f.id('round-3'); await f.poll();
  assert.equal(f.text(), '');
});

test('failed disk write is surfaced to Sona', async () => {
  const f = bridgeFixture();
  const round = await f.api.begin();
  f.failWrite();
  await assert.rejects(f.api.save('player stats', round), /保存失败/);
});

test('F7 bridge request queries once and keeps enemy and ally exports separate', async () => {
  const f = bridgeFixture(); await settle();
  const round = await f.api.begin(); await f.api.save('ally text', round);
  f.phase('InProgress'); await f.poll();
  const token = new Date().toISOString().replace(/\D/g, '').slice(0, 14) + '-123';
  f.request(token); await f.poll(); await settle();
  assert.match(f.enemy(), new RegExp('^' + token + '\\nready\\n\\[敌方\\]'));
  assert.equal(f.text(), 'ally text');
  await f.poll(); await settle();
  assert.equal(f.enemyCalls(), 1);
});

test('enemy query result is rejected if the round ends while it is pending', async () => {
  const f = bridgeFixture(); await settle();
  f.phase('InProgress'); await f.poll();
  let release;
  f.enemyHandler(() => new Promise(resolve => { release = resolve; }));
  f.request(new Date().toISOString().replace(/\D/g, '').slice(0, 14) + '-456');
  await f.poll(); await settle();
  f.phase('Lobby'); await f.poll();
  release('old enemy data'); await settle();
  assert.match(f.enemy(), /\nerror\n/);
  assert.doesNotMatch(f.enemy(), /old enemy data/);
});

test('stale request files do not trigger enemy queries', async () => {
  const f = bridgeFixture(); await settle();
  f.phase('InProgress'); await f.poll();
  f.request('20200101000000-1'); await f.poll(); await settle();
  assert.equal(f.enemyCalls(), 0);
});

function sonaFixture({ saveFails = false, deferStats = false, lobby: initialLobby = null,
  conversations = [{ id: 'lobby-room@conference.test', type: 'groupchat' }], game: initialGame = null } = {}) {
  const listeners = new Map(), calls = [], errors = [], lobbySessions = [];
  let lobby = initialLobby;
  let game = initialGame;
  let phase = game ? 'InProgress' : lobby ? 'Lobby' : 'ChampSelect', round = 1, tick, onPhase, queries = 0, enabled = true, release;
  const gate = deferStats ? new Promise(resolve => { release = resolve; }) : Promise.resolve();
  const stats = [
    { floor: 1, puuid: 'p1', gameName: '玩家甲', tagLine: 'CN1', winRate: 60, kdaNum: 4.2, strengthScore: { score: 12.3 } },
    { floor: 2, puuid: 'p2', gameName: '玩家乙', tagLine: '', winRate: null },
    { floor: 3, puuid: 'p3', gameName: '', winRate: null }
  ];
  function check(value) { if (phase !== 'ChampSelect' || value !== round) throw new Error('wrong round'); }
  const window = { __SONA_CHAT_BRIDGE__: {
    begin: async () => { check(round); return round; }, check: async value => check(value), save: async (text, value) => {
      check(value);
      if (saveFails) throw new Error('disk failure');
      calls.push(['save', text]);
    }
  } };
  const templates = {};
  for (const key of ['champSelect.teamAnalysis.floor', 'champSelect.teamAnalysis.line', 'champSelect.teamAnalysis.emptyLine']) {
    templates[key] = zhCN[key];
  }
  const scope = {
    window, document: { getElementById: () => null,
      addEventListener: (_, fn) => { if (fn.name === 'sonaManualAnalysisKey') listeners.set('key', fn); },
      removeEventListener: (_, fn) => { if (listeners.get('key') === fn) listeners.delete('key'); } },
    lcu: { getGameflowPhase: async () => phase, sendChampSelectMessage: async text => calls.push(['send', text]),
      getLobby: async () => lobby,
      getGameflowSession: async () => game,
      getSummonerInfo: async () => ({ puuid: 'self', summonerId: 99 }),
      getChatConversations: async () => conversations,
      sendChatMessage: async (id, payload) => calls.push(['lobby-send', id, payload]),
      observe: (_, fn) => { onPhase = fn; return () => {}; } },
    LcuEventUri: { GAMEFLOW_PHASE_CHANGE: 'phase' },
    setInterval(fn) { tick = fn; return 1; }, clearInterval() {},
    store: { get: key => key === 'analyzeTeamPower' ? enabled : 'celebration' },
    fetchTeamStats: async () => { queries++; await gate; return { stats }; }, getTeammateStatsKey: f => f.floor,
    queryTeamStats: async session => { lobbySessions.push(session); await gate; return { stats }; },
    getChampionById: id => ({ name: '英雄' + id }),
    translate: (key, params = {}) => (templates[key] || (key.endsWith('.ace') ? '独角马' : '萌新上线')).replace(/\{(\w+)\}/g, (_, k) => params[k]),
    sonaNotify: (text, isError) => { if (isError) errors.push(text); },
    Toast: { success() {}, error: text => errors.push(text) },
    logger: { info() {}, error() {} }
  };
  const program = compileScript(ranking) + '\n' + sonaSource + '\nconst { updateManualAnalysis, sonaQueryEnemyAnalysis } = createManualAnalysis({ fetchTeamStats, queryTeamStats, assignTitles: assignTeamPowerTitles, playerKey: getTeammateStatsKey });\nupdateManualAnalysis(true);';
  vm.runInNewContext(program, scope);
  return { calls, errors, lobbySessions, queries: () => queries, release,
    queryEnemy: () => window.__SONA_QUERY_ENEMIES__(),
    changeGame(value) { game = value; },
    changeLobby(value) { lobby = value; },
    repeatPhase() { onPhase({ data: phase }); },
    press: event => listeners.get('key')({ key: 'F8', preventDefault() {}, ...event }), tick: () => tick(),
    phase(value) { phase = value; if (value === 'ChampSelect') round++; onPhase({ data: value }); },
    disable() { enabled = false; vm.runInNewContext('updateManualAnalysis(false)', scope); } };
}

test('saves complete one-line exports and F8 sends readable two-line player blocks', async () => {
  const f = sonaFixture();
  await settle();
  assert.deepEqual(f.calls.map(c => c[0]), ['save']);
  await f.tick();
  assert.equal(f.queries(), 1);
  await f.press({ repeat: true });
  await f.press({ key: 'F7' });
  assert.equal(f.calls.length, 1);
  await f.press({});
  assert.deepEqual(f.calls.map(c => c[0]), ['save', 'send']);
  assert.match(f.calls[1][1], /\[1楼\] 玩家甲 · 独角马\n胜率 60.0% · KDA 4.20 · 评分 12.3\n\n\[2楼\]/);
  assert.doesNotMatch(f.calls[1][1], /#CN1/);
  assert.equal(f.calls[0][1].split('\n').length, 3);
  assert.match(f.calls[0][1], /玩家甲#CN1 \(1楼\).*胜率60.0%.*KDA4.20.*12.3/);
  assert.match(f.calls[0][1], /玩家乙 \(2楼\)/);
  assert.match(f.calls[0][1], /3楼：暂无有效战绩/);
  assert.doesNotMatch(f.calls[0][1], /Sona|队友卡池/);
  assert.equal(f.errors.length, 0);
});

test('F8 waits for pending automatic analysis without querying or saving twice', async () => {
  const f = sonaFixture({ deferStats: true });
  await settle();
  const pressing = f.press({});
  await settle();
  assert.equal(f.calls.length, 0);
  f.release(); await pressing;
  assert.equal(f.queries(), 1);
  assert.deepEqual(f.calls.map(c => c[0]), ['save', 'send']);
});

test('duplicate selection phase notifications reuse the saved analysis', async () => {
  const f = sonaFixture();
  await settle();
  f.repeatPhase();
  await settle();
  await f.tick();
  assert.equal(f.queries(), 1);
  assert.equal(f.calls.filter(([kind]) => kind === 'save').length, 1);
});

test('automatic write failure prevents F8 send and can be retried', async () => {
  const f = sonaFixture({ saveFails: true });
  await settle();
  await f.press({});
  assert.equal(f.calls.length, 0);
  assert.match(f.errors[0], /disk failure/);
});

test('Sona ignores F8 in game and auto-saves the next selection without sending', async () => {
  const f = sonaFixture();
  await settle();
  f.phase('InProgress'); await f.press({}); await f.tick();
  assert.deepEqual(f.calls.map(c => c[0]), ['save']);
  f.phase('ChampSelect'); await settle();
  assert.deepEqual(f.calls.map(c => c[0]), ['save', 'save']);
});

test('leaving selection or disabling during analysis prevents late save and send', async () => {
  for (const action of ['phase', 'disable']) {
    const f = sonaFixture({ deferStats: true });
    await settle();
    if (action === 'phase') f.phase('Lobby'); else f.disable();
    f.release(); await settle();
    assert.equal(f.calls.length, 0);
  }
});

const testLobby = () => ({ partyId: 'party-1', multiUserChatId: 'lobby-room', gameConfig: { queueId: 0 }, localMember: { teamId: 100 }, members: [
  { puuid: 'p1', gameName: '玩家甲', summonerId: 1, teamId: 100 },
  { puuid: 'p2', gameName: '玩家乙', summonerId: 2, teamId: 100 },
  { puuid: 'enemy', summonerId: 4, teamId: 200 },
  { puuid: 'bot', teamId: 100, isBot: true },
  { puuid: 'spectator', teamId: 100, isSpectator: true }
] });

test('lobby F8 queries own party and sends to matching room without overwriting game export', async () => {
  const f = sonaFixture({ lobby: testLobby() });
  await settle();
  assert.equal(f.lobbySessions.length, 0);
  await f.press({});
  assert.equal(f.lobbySessions.length, 1);
  assert.deepEqual(Array.from(f.lobbySessions[0].myTeam, player => player.puuid), ['p1', 'p2']);
  assert.equal(f.lobbySessions[0].queueId, 0);
  assert.deepEqual(f.calls.map(call => call[0]), ['lobby-send']);
  assert.equal(f.calls[0][1], 'lobby-room@conference.test');
  assert.equal(f.calls[0][2].type, 'celebration');
  assert.match(f.calls[0][2].body, /近期全部模式/);
  assert.match(f.calls[0][2].body, /\[1楼\] 玩家甲 · 独角马\n胜率 60.0%/);
  assert.match(f.calls[0][2].body, /\[2楼\] 玩家乙\n暂无有效战绩 \/ 查询失败/);
  assert.equal(f.errors.length, 0);
});

test('lobby F8 never falls back to private or another room chat', async () => {
  const f = sonaFixture({ lobby: testLobby(), conversations: [
    { id: 'lobby-room@friend.test', type: 'chat' },
    { id: 'another-room@conference.test', type: 'groupchat' }
  ] });
  await settle(); await f.press({});
  assert.equal(f.calls.length, 0);
  assert.match(f.errors[0], /房间聊天尚未就绪/);
});

test('lobby F8 discards results if members change or selection starts during the query', async () => {
  for (const change of ['members', 'phase']) {
    const f = sonaFixture({ lobby: testLobby(), deferStats: true });
    await settle();
    const pending = f.press({}); await settle();
    if (change === 'members') {
      const lobby = testLobby(); lobby.members = lobby.members.slice(0, 1); f.changeLobby(lobby);
    } else f.phase('InProgress');
    f.release(); await pending;
    assert.equal(f.calls.length, 0);
  }
});

const testEnemyGame = () => ({ gameData: { gameId: 101, queue: { id: 2400 },
  teamOne: [{ puuid: 'self', summonerId: 99 }],
  teamTwo: [{ puuid: 'p1', championId: 11 }, { puuid: 'p2', championId: 22 }] } });

test('enemy query chooses opponents by self identity on either side and reuses the current queue', async () => {
  for (const swapped of [false, true]) {
    const game = testEnemyGame();
    if (swapped) [game.gameData.teamOne, game.gameData.teamTwo] = [game.gameData.teamTwo, game.gameData.teamOne];
    const f = sonaFixture({ game }); await settle();
    const text = await f.queryEnemy();
    assert.deepEqual(Array.from(f.lobbySessions[0].myTeam, player => player.puuid), ['p1', 'p2']);
    assert.equal(f.lobbySessions[0].queueId, 2400);
    assert.match(text, /\[敌方\] 英雄11 玩家甲.*胜率60.0%/);
    assert.match(text, /\[敌方\] 英雄22 玩家乙：暂无有效战绩/);
    assert.equal(f.calls.length, 0);
  }
});

test('enemy query refuses unidentified own team and changed game IDs', async () => {
  const game = testEnemyGame(); game.gameData.teamOne = [];
  await assert.rejects(sonaFixture({ game }).queryEnemy(), /无法确认己方/);
  const f = sonaFixture({ game: testEnemyGame(), deferStats: true });
  await settle(); const pending = f.queryEnemy(); await settle();
  const replacement = testEnemyGame(); replacement.gameData.gameId = 202;
  f.changeGame(replacement); f.release();
  await assert.rejects(pending, /对局已结束或更换/);
});

test('AHK reads 1.1.6 encrypted datastore, mirrors Unicode text and rejects missing/stale data', t => {
  const ahk = process.env.AUTOHOTKEY_EXE || 'C:/Users/Administrator/AppData/Local/Programs/AutoHotkey/v2/AutoHotkey64.exe';
  if (!fs.existsSync(ahk)) { t.skip('AutoHotkey v2 is not installed'); return; }
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sona-bridge-test-'));
  const key = Buffer.from('A5dgY6lz9fpG9kGNiH1mZ');
  function writeStore(name, value, enemy = '') {
    const data = Buffer.from(JSON.stringify({ unrelated: '另一插件的设置', 'sona-chat-bridge.export.v1': value, 'sona-chat-bridge.enemy.v1': enemy }));
    for (let i = 0; i < data.length; i++) data[i] ^= key[i % key.length];
    const target = path.join(tempRoot, name);
    fs.writeFileSync(target, data);
    return target;
  }
  const text = '玩家甲#CN1 (1楼): 🏇 上等马|胜率60%|KDA4.2\n玩家乙 (2楼): 萌新上线';
  const stamp = new Date().toISOString().replace(/\D/g, '').slice(0, 14);
  const ready = writeStore('ready', Buffer.from(`${stamp}\n${text}`).toString('base64'));
  const empty = writeStore('empty', '');
  const stale = writeStore('stale', Buffer.from(`20200101000000\n${text}`).toString('base64'));
  const enemyToken = stamp + '-123';
  const enemyReady = writeStore('enemy-ready', '', Buffer.from(`${stamp}\n${enemyToken}\nready\n${text}`).toString('base64'));
  const corrupt = path.join(tempRoot, 'corrupt');
  fs.writeFileSync(corrupt, 'not a datastore');
  const messageFile = path.join(tempRoot, 'team-chat.txt');
  const output = path.join(tempRoot, 'actual.txt');
  const source = fs.readFileSync(new URL('../sona-chat-bridge/SonaChat.ahk', import.meta.url), 'utf8');
  const prefix = source.slice(0, source.indexOf('#HotIf WinActive')).replace(/^\uFEFF/, '').replace(/^#Warn\s*$/m, '#Warn All, StdOut');
  const harness = path.join(tempRoot, 'verify.ahk');
  fs.writeFileSync(harness, '\uFEFF' + prefix + `
SetTimer SyncExportFile, 0
messageFile := "${messageFile}"
datastoreFile := "${ready}"
if !SyncExportFile()
    ExitApp 11
testMessage := ReadCurrentMessage()
FileAppend testMessage, "${output}", "UTF-8-RAW"
datastoreFile := "${empty}"
if !SyncExportFile() || FileRead(messageFile, "UTF-8") != ""
    ExitApp 12
datastoreFile := "${stale}"
if !SyncExportFile() || ReadCurrentMessage() != ""
    ExitApp 13
datastoreFile := "${corrupt}"
if SyncExportFile() || ReadCurrentMessage() != ""
    ExitApp 14
datastoreFile := "${enemyReady}"
enemyParts := ReadEnemyResponse("${enemyToken}")
if enemyParts.Length != 4 || enemyParts[3] != "ready" || enemyParts[4] != testMessage
    ExitApp 15
if ReadEnemyResponse("wrong-request").Length != 0
    ExitApp 16
ExitApp 0
`);
  try {
    const result = spawnSync(ahk, ['/ErrorStdOut', harness], { encoding: 'utf8', timeout: 15000 });
    assert.equal(result.status, 0, result.stdout + result.stderr + (result.error || ''));
    assert.equal(result.stdout.trim(), '', 'AHK must run without variable warnings');
    assert.equal(fs.readFileSync(output, 'utf8'), text);
  } finally {
    assert.ok(path.resolve(tempRoot).startsWith(path.resolve(os.tmpdir()) + path.sep + 'sona-bridge-test-'));
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
