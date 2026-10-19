/** Pengu 1.1.6: persist via DataStore; AHK mirrors the export to team-chat.txt. */
const EXPORT_KEY = 'sona-chat-bridge.export.v1';
const ENEMY_KEY = 'sona-chat-bridge.enemy.v1';
const PHASE_PATH = '/lol-gameflow/v1/gameflow-phase';

export function init(context) {
  if (typeof window.DataStore?.set !== 'function') {
    console.error('[sona-chat-bridge] 未找到 Pengu DataStore，请确认使用 Pengu Loader 1.1.6。');
    return;
  }

  let phase = '';
  let conversationId = '';
  let generation = 0;
  let active = true;
  let queue = Promise.resolve();
  let polling = false;
  let lastEnemyRequest = null;
  let enemyBusy = false;
  let allyText = '';

  // Serialize phase refreshes and writes so old exports cannot overwrite a new round.
  function run(task) {
    const result = queue.catch(() => {}).then(() => {
      if (!active) throw new Error('桥接插件已关闭');
      return task();
    });
    queue = result;
    return result;
  }

  async function write(text, key = EXPORT_KEY) {
    // ASCII base64 lets AHK extract this one value without parsing other plugins' data.
    const savedAt = new Date().toISOString().replace(/\D/g, '').slice(0, 14);
    const bytes = new TextEncoder().encode(`${savedAt}\n${text}`);
    const encoded = text ? btoa(Array.from(bytes, byte => String.fromCharCode(byte)).join('')) : '';
    if (!window.DataStore.set(key, encoded) || window.DataStore.get(key) !== encoded) {
      throw new Error('保存失败：无法写入 Pengu DataStore');
    }
    if (key === EXPORT_KEY) allyText = text;
  }

  async function readJson(path) {
    const response = await window.fetch(path);
    if (!response.ok) throw new Error(`无法读取客户端状态 (${response.status})`);
    return response.json();
  }

  async function refresh() {
    const next = await readJson(PHASE_PATH);
    if (typeof next !== 'string') throw new Error('无效的客户端阶段');
    const invalidate = next !== phase && !['ChampSelect', 'GameStart', 'InProgress', 'Reconnect'].includes(next);
    if (invalidate) {
      generation++;
      conversationId = '';
      await write('');
      await write('', ENEMY_KEY);
    }
    if (next === 'ChampSelect') {
      // Detect another round even if a brief dodge was missed by polling.
      const conversations = await readJson('/lol-chat/v1/conversations');
      const id = conversations.find(c => c.type === 'championSelect')?.id;
      if (!id) throw new Error('选人聊天室尚未就绪，等待自动分析重试，或按 F8 重试');
      if (phase !== 'ChampSelect' || id !== conversationId) {
        generation++;
        conversationId = id;
        await write('');
        await write('', ENEMY_KEY);
      }
    }
    phase = next;
  }

  function checkRound(round) {
    if (phase !== 'ChampSelect' || round !== generation) {
      throw new Error('选人阶段已结束或对局已更换，请等待本局选人阶段自动分析完成');
    }
  }

  const api = {
    begin: () => run(async () => {
      await refresh();
      checkRound(generation);
      return generation;
    }),
    check: round => run(async () => {
      await refresh();
      checkRound(round);
    }),
    save: (text, round) => run(async () => {
      await refresh();
      checkRound(round);
      if (typeof text !== 'string' || !text.trim()) throw new Error('分析文本为空');
      await write(text);
      console.info('[sona-chat-bridge] 已保存本局分析到 DataStore；AHK 将同步 team-chat.txt');
    })
  };

  // Clear an earlier run before accepting a new round export.
  void run(() => write('')).catch(error => console.error('[sona-chat-bridge]', error));
  void run(() => write('', ENEMY_KEY)).catch(error => console.error('[sona-chat-bridge]', error));
  window.__SONA_CHAT_BRIDGE__ = api;

  async function checkEnemyRequest() {
    if (enemyBusy) return;
    const url = new URL('./enemy-request.txt', import.meta.url);
    url.searchParams.set('t', String(Date.now()));
    const response = await window.fetch(url.href, { cache: 'no-store' });
    const token = response.ok ? (await response.text()).trim() : '';
    // Ignore a request left on disk before this plugin started.
    if (lastEnemyRequest === null) { lastEnemyRequest = token; return; }
    if (!token || token === lastEnemyRequest) return;
    lastEnemyRequest = token;
    if (!/^\d{14}-\d+$/.test(token)) return;
    const stamp = token.slice(0, 14);
    const requestedAt = Date.UTC(+stamp.slice(0, 4), +stamp.slice(4, 6) - 1, +stamp.slice(6, 8),
      +stamp.slice(8, 10), +stamp.slice(10, 12), +stamp.slice(12, 14));
    if (Date.now() - requestedAt > 60000 || requestedAt - Date.now() > 2000) return;
    enemyBusy = true;
    const startedGeneration = generation;
    void (async () => {
      try {
        await write(`${token}\nloading\n正在查询敌方…`, ENEMY_KEY);
        if (!['GameStart', 'InProgress', 'Reconnect'].includes(phase)) throw new Error('请在本局游戏中按 F7');
        if (typeof window.__SONA_QUERY_ENEMIES__ !== 'function') throw new Error('请更新 Sona 并重启客户端');
        const text = await window.__SONA_QUERY_ENEMIES__();
        await run(refresh);
        if (startedGeneration !== generation || !['GameStart', 'InProgress', 'Reconnect'].includes(phase))
          throw new Error('对局已变化，已取消敌方查询');
        await write(`${token}\nready\n${text}`, ENEMY_KEY);
      } catch (error) {
        if (active) await write(`${token}\nerror\n${error.message || error}`, ENEMY_KEY);
      } finally {
        enemyBusy = false;
      }
    })().catch(error => console.error('[sona-chat-bridge] 敌方结果保存失败', error));
  }

  async function poll() {
    if (polling || !active) return;
    polling = true;
    try {
      await run(refresh);
      if (['GameStart', 'InProgress', 'Reconnect'].includes(phase) && allyText &&
          typeof window.__SONA_GET_ALLY_ANALYSIS__ === 'function') {
        const startedGeneration = generation;
        const text = await window.__SONA_GET_ALLY_ANALYSIS__().catch(error => {
          console.debug('[sona-chat-bridge] 开黑分组暂未就绪', error.message);
          return null;
        });
        await run(async () => {
          await refresh();
          if (startedGeneration === generation && ['GameStart', 'InProgress', 'Reconnect'].includes(phase) &&
              text && text !== allyText) await write(text);
        });
      }
      await checkEnemyRequest();
    } catch (error) {
      // Sona reports actionable errors; startup polls may fail until LCU/chat is ready.
      console.debug('[sona-chat-bridge]', error.message);
    } finally {
      polling = false;
    }
  }
  const timer = setInterval(poll, 1500);
  void poll();
  window.addEventListener('beforeunload', () => {
    active = false;
    clearInterval(timer);
    if (window.__SONA_CHAT_BRIDGE__ === api) delete window.__SONA_CHAT_BRIDGE__;
  }, { once: true });
}
