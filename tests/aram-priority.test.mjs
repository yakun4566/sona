import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

import { loadScript } from './source-loader.mjs';
const code = loadScript('src/lib/custom/auto-pick.ts') + '\n' + loadScript('src/lib/features/auto-lock-champion.ts');
const settle = async () => { for (let i = 0; i < 4; i++) await new Promise(setImmediate); };

function mockPauseDom() {
  const keys = new Map(), tasks = new Set();
  class Element {
    constructor() { this.children = []; this.attributes = new Map(); this.style = {}; this.events = new Map(); }
    setAttribute(name, value) { this.attributes.set(name, value); }
    addEventListener(name, fn) { this.events.set(name, fn); }
    querySelector(selector) { return this.children.find(child => child.attributes.has(selector.slice(1, -1))) || null; }
    get firstChild() { return this.children[0] || null; }
    insertBefore(child, before) { this.children.splice(before ? this.children.indexOf(before) : this.children.length, 0, child); child.parent = this; }
    remove() { if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this); }
  }
  const container = new Element();
  const quit = new Element(); quit.setAttribute('data-sona-quit-button', 'true'); container.insertBefore(quit, null);
  return { container, tasks, keys,
    document: {
      querySelector: selector => selector === '.bottom-right-buttons' ? container : container.querySelector(selector),
      querySelectorAll: selector => container.children.filter(child => child.attributes.has(selector.slice(1, -1))),
      createElement: () => new Element(),
      addEventListener: (name, fn) => keys.set(name, fn), removeEventListener: name => keys.delete(name)
    },
    injector: { register(fn) { tasks.add(fn); fn(); }, unregister(fn) { tasks.delete(fn); } }
  };
}

function fixture({ current = 99, bench = [22], priorities = [11, 22, 33], gameMode = 'ARAM',
  benchEnabled = true, disabled = [], onTick = () => {}, reject = () => false, disabledGate,
  confirmImmediately = true, pickResponse = async () => ({ ok: true }), autoAdvance = true,
  pickable = [11, 22, 33], subset = [], subsetGate, sessionGate, onSwap = async () => {} } = {}) {
  let enabled = true, phase = 'ChampSelect', ticks = 0, clock = 10000;
  const listeners = new Map(), timers = new Map();
  const reads = { session: 0, disabled: 0, pickable: 0 };
  const emitData = (uri, data, eventType = 'Update') => {
    for (const fn of listeners.get(uri) || []) fn({ data, eventType });
  };
  const swaps = [], picks = [];
  const dom = mockPauseDom();
  const session = { benchEnabled, queueId: 450, gameMode, localPlayerCellId: 0,
    myTeam: [{ cellId: 0, championId: current }], theirTeam: [], bans: { myTeamBans: [], theirTeamBans: [] },
    benchChampions: bench.map(championId => ({ championId })), actions: [], timer: { phase: 'FINALIZATION' } };
  const scope = {
    document: dom.document, injector: dom.injector, sonaNotify() {}, Toast: { success() {} },
    Date: { now: () => clock }, getChampionById: () => null, translate: () => '',
    setTimeout(fn, ms) {
      const timer = {};
      timers.set(timer, { fn, ms });
      if (autoAdvance) timer.handle = setImmediate(() => {
        if (!timers.delete(timer)) return;
        scope.sleep(ms); fn();
      });
      return timer;
    },
    clearTimeout(timer) { if (timer) { timers.delete(timer); clearImmediate(timer.handle); } },
    store: { get: key => key === 'autoLockChampionIds' ? priorities : key === 'autoLockChampion' ? enabled : true },
    logger: { info() {}, warn() {}, error() {} }, getQueue: () => ({ isRanked: false }), notifyAutoLockSuccess: async () => {},
    LcuEventUri: { GAMEFLOW_PHASE_CHANGE: 'phase' },
    lcu: {
      getGameflowPhase: async () => phase,
      getChampSelectSession: async () => {
        reads.session++;
        const snapshot = structuredClone(session);
        if (sessionGate) await (typeof sessionGate === 'function' ? sessionGate(reads.session) : sessionGate);
        return snapshot;
      },
      getDisabledChampionIds: async () => { reads.disabled++; if (disabledGate) await disabledGate; return disabled; },
      getPickableChampionIds: async () => { reads.pickable++; return pickable; },
      observe: (uri, fn) => {
        if (!listeners.has(uri)) listeners.set(uri, new Set());
        listeners.get(uri).add(fn);
        return () => listeners.get(uri).delete(fn);
      },
      benchSwap: async id => {
        swaps.push(id);
        await onSwap(id);
        if (reject(id)) throw new Error('unavailable or cooldown');
        const previous = session.myTeam[0].championId;
        if (confirmImmediately) session.myTeam[0].championId = id;
        session.benchChampions = session.benchChampions.filter(hero => hero.championId !== id);
        session.benchChampions.push({ championId: previous });
      }
    },
    fetch: async (_, options) => {
      if (!options) { if (subsetGate) await subsetGate; return { ok: true, json: async () => subset }; }
      picks.push(JSON.parse(options.body)); return pickResponse();
    },
    sleep: async ms => {
      ticks++; clock += ms;
      onTick({ ticks, session, priorities, swaps });
      if (ticks >= 8) phase = 'InProgress';
    }
  };
  vm.createContext(scope);
  vm.runInContext(code, scope);
  return { swaps, picks, session, priorities, dom, reads, timers,
    listeners: () => [...listeners.values()].reduce((sum, set) => sum + set.size, 0),
    updateSession() { emitData('/lol-champ-select/v1/session', structuredClone(session)); },
    updateDisabled(ids) { emitData('/lol-champ-select/v1/disabled-champion-ids', ids); },
    updatePickable(ids) { emitData('/lol-champ-select/v1/pickable-champion-ids', ids); },
    updateSubset(ids) { emitData('/lol-lobby-team-builder/champ-select/v1/subset-champion-list', ids); },
    deleteSession() { emitData('/lol-champ-select/v1/session', null, 'Delete'); },
    async advance(ms) {
      clock += ms;
      const pending = [...timers];
      timers.clear();
      for (const [, timer] of pending) timer.fn();
      await settle();
    },
    paused: () => vm.runInContext('sonaAutoPickPaused', scope),
    toggle: () => vm.runInContext('sonaToggleAutoPickPause()', scope),
    candidates: () => Array.from(vm.runInContext('sonaBenchCandidates(xSession)', Object.assign(scope, { xSession: session }))),
    watch: () => vm.runInContext('sonaWatchPriorityBench(sonaAutoPickRun)', scope),
    normal: () => vm.runInContext('tryAutoLockChampion()', scope),
    enable: () => vm.runInContext('updateAutoLockChampion(true)', scope),
    disable: () => { enabled = false; vm.runInContext('updateAutoLockChampion(false)', scope); },
    emit(value) { phase = value; emitData('phase', value); }
  };
}

for (const gameMode of ['ARAM', 'KIWI']) {
  test(`${gameMode}: takes second priority from bench with no normal pick action`, async () => {
    const f = fixture({ gameMode });
    await f.normal();
    assert.deepEqual(f.swaps, [22]);
    assert.equal(f.picks.length, 0);
  });
}

test('priority order beats bench order; current hero prevents downgrades and needless swaps', () => {
  assert.deepEqual(fixture({ bench: [33, 22, 11] }).candidates(), [11, 22, 33]);
  assert.deepEqual(fixture({ current: 22, bench: [33, 11, 22] }).candidates(), [11]);
  assert.deepEqual(fixture({ current: 11, bench: [22, 33] }).candidates(), []);
  assert.deepEqual(fixture({ current: 0, bench: [11] }).candidates(), []);
});

test('keeps watching, upgrades to first priority when it appears, never swaps back', async () => {
  const f = fixture({ onTick: ({ ticks, session }) => {
    if (ticks === 2) session.benchChampions.push({ championId: 11 });
  } });
  await f.watch();
  assert.deepEqual(f.swaps, [22, 11]);
});

test('waits when no target exists and picks a target added later', async () => {
  const f = fixture({ bench: [], onTick: ({ ticks, session }) => {
    if (ticks === 3) session.benchChampions.push({ championId: 22 });
  } });
  await f.watch();
  assert.deepEqual(f.swaps, [22]);
});

test('an initially empty priority list can acquire its first champion during ARAM selection', async () => {
  const f = fixture({ priorities: [], onTick({ ticks, priorities }) { if (ticks === 2) priorities.push(22); } });
  await f.normal();
  assert.deepEqual(f.swaps, [22]);
});

test('disabled targets are skipped; failed first target backs off and tries second', async () => {
  const disabled = fixture({ bench: [11, 22], disabled: [11] });
  await disabled.watch();
  assert.deepEqual(disabled.swaps, [22]);
  const failed = fixture({ bench: [11, 22], reject: id => id === 11 });
  await failed.watch();
  assert.deepEqual(failed.swaps.slice(0, 2), [11, 22]);
});

test('starts when enabled during selection, deduplicates phase events, stops when disabled', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const f = fixture({ disabledGate: gate });
  f.enable(); await settle();
  f.emit('ChampSelect');
  f.disable(); release(); await settle();
  assert.deepEqual(f.swaps, []);
});

test('leaving selection while eligibility is pending cancels exchange', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const f = fixture({ disabledGate: gate });
  f.enable(); await settle();
  f.emit('GameStart'); release(); await settle();
  assert.deepEqual(f.swaps, []);
});

test('waits for successful exchange to appear in session instead of taking a lower hero', async () => {
  const f = fixture({ bench: [11, 33], confirmImmediately: false,
    onTick: ({ ticks, session }) => { if (ticks === 3) session.myTeam[0].championId = 11; } });
  await f.watch();
  assert.deepEqual(f.swaps, [11]);
});

test('repeated ChampSelect event does not start a second exchange worker', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const f = fixture({ disabledGate: gate });
  f.enable(); await settle();
  f.emit('ChampSelect'); release(); await settle();
  assert.deepEqual(f.swaps, [22]);
});

test('normal selection still uses pick action and selects second available priority', async () => {
  const f = fixture({ benchEnabled: false, pickable: [22] });
  f.session.actions = [[{ id: 10, actorCellId: 0, type: 'pick', completed: false, isInProgress: true, championId: 0 }]];
  await f.normal();
  assert.deepEqual(f.swaps, []);
  assert.equal(f.picks.length, 1);
  assert.equal(f.picks[0].championId, 22);
  assert.equal(f.picks[0].completed, true);
});

test('button mounts before exit, pauses pending exchange, resumes and resets next round', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const f = fixture({ disabledGate: gate });
  f.enable(); await settle();
  const button = f.dom.container.children[0];
  assert.equal(button.textContent, '暂停秒抢');
  assert.equal(f.dom.container.children[1].attributes.get('data-sona-quit-button'), 'true');
  button.events.get('click')({ preventDefault() {}, stopPropagation() {} });
  assert.equal(button.textContent, '恢复秒抢');
  assert.equal(button.attributes.get('aria-pressed'), 'true');
  release(); await settle();
  assert.deepEqual(f.swaps, []);
  f.toggle(); await settle();
  assert.deepEqual(f.swaps, [22]);
  f.toggle();
  assert.equal(f.paused(), true);
  f.emit('Lobby');
  assert.equal(f.dom.container.children.length, 1);
  assert.equal(f.dom.tasks.size, 0);
  f.emit('ChampSelect'); await settle();
  assert.equal(f.paused(), false);
  assert.equal(f.dom.container.children[0].textContent, '暂停秒抢');
});

test('pausing during normal pick response prevents backup requests', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const f = fixture({ benchEnabled: false, pickable: [22], pickResponse: () => gate });
  f.session.actions = [[{ id: 10, actorCellId: 0, type: 'pick', completed: false, isInProgress: true, championId: 0 }]];
  f.enable(); await settle();
  assert.equal(f.picks.length, 1);
  f.toggle(); release({ ok: false }); await settle();
  assert.equal(f.picks.length, 1);
});

test('pause is button-only and remount retains the current pause state', async () => {
  const f = fixture({ autoAdvance: false });
  f.enable(); await settle();
  assert.equal(f.dom.keys.size, 0);
  f.toggle(); await settle();
  for (const task of f.dom.tasks) task();
  assert.equal(f.paused(), true);
  f.disable();
});

test('session event exchanges immediately with cached eligibility, without a timer tick or GET', async () => {
  const f = fixture({ bench: [], autoAdvance: false });
  const running = f.watch(); await settle();
  const reads = { ...f.reads };
  f.session.benchChampions = [{ championId: 22 }];
  f.updateSession(); await settle();
  assert.deepEqual(f.swaps, [22]);
  assert.deepEqual(f.reads, reads);
  f.deleteSession(); await running;
  assert.equal(f.listeners(), 0);
  assert.equal(f.timers.size, 0);
});

test('eligibility events immediately reconsider a visible champion', async () => {
  const f = fixture({ disabled: [22], pickable: [], autoAdvance: false });
  const running = f.watch(); await settle();
  f.updateDisabled([]); await settle();
  assert.deepEqual(f.swaps, []);
  f.updatePickable([22]); await settle();
  assert.deepEqual(f.swaps, [22]);
  f.deleteSession(); await running;
});

test('missed events are recovered by the one-second fallback', async () => {
  const f = fixture({ bench: [], autoAdvance: false });
  const running = f.watch(); await settle();
  f.session.benchChampions.push({ championId: 22 });
  await f.advance(1000);
  assert.deepEqual(f.swaps, [22]);
  f.deleteSession(); await running;
});

test('a slow fallback GET does not block an incoming session event', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const f = fixture({ bench: [], autoAdvance: false, sessionGate: read => read > 1 ? gate : undefined });
  const running = f.watch(); await settle();
  await f.advance(1000);
  f.session.benchChampions = [{ championId: 22 }];
  f.updateSession(); await settle();
  assert.deepEqual(f.swaps, [22]);
  release(); await settle();
  f.deleteSession(); await running;
});

test('events during an in-flight exchange cannot start concurrent requests', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const f = fixture({ autoAdvance: false, onSwap: () => gate });
  const running = f.watch(); await settle();
  for (let i = 0; i < 10; i++) f.updateSession();
  await settle();
  assert.deepEqual(f.swaps, [22]);
  release(); await settle();
  f.updateSession(); await settle();
  assert.deepEqual(f.swaps, [22]);
  f.deleteSession(); await running;
});

test('an event snapshot is not overwritten by an older GET result', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const f = fixture({ sessionGate: gate, autoAdvance: false });
  const running = f.watch(); await settle();
  f.session.benchChampions = [{ championId: 11 }];
  f.updateSession(); release(); await settle();
  assert.deepEqual(f.swaps, [11]);
  f.deleteSession(); await running;
});

test('pause immediately removes subscriptions and timers; resume uses a fresh session', async () => {
  const f = fixture({ bench: [], autoAdvance: false });
  f.enable(); await settle();
  assert.equal(f.listeners(), 5);
  f.toggle(); await settle();
  assert.equal(f.listeners(), 1);
  assert.equal(f.timers.size, 0);
  f.session.benchChampions = [{ championId: 22 }];
  f.updateSession(); await settle();
  assert.deepEqual(f.swaps, []);
  f.toggle(); await settle();
  assert.deepEqual(f.swaps, [22]);
  f.disable(); await settle();
  assert.equal(f.listeners(), 0);
  assert.equal(f.timers.size, 0);
});

test('leaving selection immediately removes subscriptions and timers', async () => {
  const f = fixture({ bench: [], autoAdvance: false });
  f.enable(); await settle();
  f.emit('InProgress'); await settle();
  assert.equal(f.listeners(), 1);
  assert.equal(f.timers.size, 0);
  f.disable();
});

function configureCards(f) {
  f.session.allowSubsetChampionPicks = true;
  f.session.timer.phase = 'BAN_PICK';
  f.session.actions = [[{ id: 12, actorCellId: 0, type: 'pick', completed: false, isInProgress: true, championId: 0 }]];
}

test('initial card selection uses the highest priority in the subset, not the full roster', async () => {
  const f = fixture({ current: 0, benchEnabled: false, subset: [33, 22], autoAdvance: false });
  configureCards(f);
  const running = f.normal(); await settle();
  assert.deepEqual(f.swaps, []);
  assert.equal(f.picks.length, 1);
  assert.deepEqual(f.picks[0], { type: 'pick', championId: 22, completed: true });
  f.deleteSession(); await running;
});

test('subset event enables a card pick; missing/empty subset never falls back to all heroes', async () => {
  const f = fixture({ current: 0, subset: [], autoAdvance: false });
  configureCards(f);
  const running = f.normal(); await settle();
  assert.deepEqual(f.picks, []);
  f.updateSubset([33]); await settle();
  assert.equal(f.picks[0].championId, 33);
  f.deleteSession(); await running;
});

test('subset restriction lifts after the card phase; later bench upgrade still works', async () => {
  const f = fixture({ current: 22, bench: [11], subset: [22, 33], autoAdvance: false });
  configureCards(f);
  f.session.actions[0][0].completed = true;
  const running = f.normal(); await settle();
  assert.deepEqual(f.swaps, []);
  f.session.timer.phase = 'FINALIZATION';
  f.updateSession(); await settle();
  assert.deepEqual(f.swaps, [11]);
  f.deleteSession(); await running;
});

test('failed exchange can retry after 250ms instead of the old two-second backoff', async () => {
  let failed = false;
  const f = fixture({ autoAdvance: false, reject: () => { if (failed) return false; failed = true; return true; } });
  const running = f.watch(); await settle();
  assert.deepEqual(f.swaps, [22]);
  await f.advance(250);
  assert.deepEqual(f.swaps, [22, 22]);
  f.deleteSession(); await running;
});
