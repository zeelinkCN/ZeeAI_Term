import test from 'node:test';
import assert from 'node:assert/strict';
import { AiMonitorStore, monitorSessionKey, uniqueMonitorSessions } from '../src/lib/ai-monitor.ts';
import { SessionBus } from '../src/sessionBus.ts';

const native = (store, state, extra = {}) => store.report('s1', { state, id: '', app: 'codex', ...extra }, 1000);
function store(herdr = false) {
  const value = new AiMonitorStore();
  value.sync([{ id: 's1', connected: true, herdr }]);
  return value;
}

test('native lifecycle deduplicates alerts; completion is a turn edge, not the initial snapshot', () => {
  const value = store();
  assert.deepEqual(native(value, 'done'), []);
  assert.equal(value.views()[0].unread, false);
  assert.deepEqual(native(value, 'working'), []);
  assert.equal(native(value, 'blocked', { kind: 'permission' })[0].kind, 'blocked');
  assert.deepEqual(native(value, 'blocked', { kind: 'permission', message: 'redraw' }), []);
  value.acknowledge();
  assert.equal(value.views()[0].state, 'blocked');
  assert.equal(native(value, 'blocked', { kind: 'auth' })[0].kind, 'blocked');
  assert.equal(native(value, 'done')[0].kind, 'done');
  assert.equal(value.views()[0].unread, true);
  assert.deepEqual(native(value, 'done'), []);
  value.acknowledge();
  assert.equal(value.views()[0].unread, false);
  native(value, 'working');
  assert.equal(native(value, 'done').length, 1);
});

test('silent output has no meaning and disconnect never produces finished', () => {
  const value = store();
  native(value, 'working');
  assert.equal(value.views()[0].state, 'working');
  value.sync([{ id: 's1', connected: false, herdr: false }]);
  assert.equal(value.views()[0].state, 'unknown');
  assert.match(value.views()[0].health, /断开/);
  assert.equal(value.views()[0].unread, false);
  assert.deepEqual(native(value, 'done'), []);
  value.sync([{ id: 's1', connected: true, herdr: false }]);
  assert.equal(value.views()[0].state, 'unknown');
  assert.deepEqual(native(value, 'done'), []);
});

test('hierarchical records aggregate into one card; a working child prevents premature completion', () => {
  const value = store();
  native(value, 'working');
  value.report('s1', { state: 'working', id: 'tools/test' }, 1001);
  assert.deepEqual(native(value, 'done'), []);
  assert.equal(value.views()[0].state, 'working');
  assert.equal(value.report('s1', { state: 'done', id: 'tools/test' }, 1002)[0].kind, 'done');
  assert.equal(value.views()[0].records, 2);
  native(value, 'clear', { id: 'tools' });
  assert.equal(value.views()[0].records, 1);
  native(value, 'clear');
  assert.equal(value.views()[0].state, 'unknown');
});

test('only recognized AI programs are accepted, with bounded records and no cross-session attribution', () => {
  const value = store();
  assert.deepEqual(native(value, 'blocked', { app: 'make' }), []);
  assert.equal(value.views()[0].state, 'unknown');
  assert.deepEqual(native(value, 'blocked', { app: undefined }), []);
  assert.deepEqual(value.report('outside', { state: 'blocked', id: '', app: 'codex' }, 1), []);
  native(value, 'working', { app: 'claude-code' });
  assert.equal(value.views()[0].agent, 'claude');
  native(value, 'working', { app: 'npm' });
  assert.equal(value.views()[0].agent, undefined);
  for (let i = 0; i < 200; i++) native(value, 'working', { id: String(i) });
  assert.equal(value.views()[0].records, 128);
});

test('replacing the last AI record with another program removes its completion badge', () => {
  const value = store();
  native(value, 'working');
  native(value, 'done');
  assert.equal(value.views()[0].unread, true);

  assert.deepEqual(native(value, 'working', { app: 'make' }), []);
  const view = value.views()[0];
  assert.equal(view.state, 'unknown');
  assert.equal(view.records, 0);
  assert.equal(view.unread, false);
});

test('removing a completed child clears its badge while preserving the idle parent', () => {
  for (const replacement of [{ state: 'clear', id: 'child' }, { state: 'working', id: 'child', app: 'make' }]) {
    const value = store();
    native(value, 'idle');
    value.report('s1', { state: 'working', id: 'child' }, 1001);
    value.report('s1', { state: 'done', id: 'child' }, 1002);
    assert.equal(value.views()[0].unread, true);

    assert.deepEqual(value.report('s1', replacement, 1003), []);
    const view = value.views()[0];
    assert.equal(view.state, 'idle');
    assert.equal(view.records, 1);
    assert.equal(view.unread, false);
  }
});

test('shell prompt clears live states but preserves ended results, without generating completion', () => {
  const value = store();
  native(value, 'blocked');
  value.prompt('s1');
  assert.equal(value.views()[0].state, 'unknown');
  native(value, 'working');
  native(value, 'done');
  value.prompt('s1');
  assert.equal(value.views()[0].state, 'done');
});

test('herdr failures preserve baseline, recovered same state does not re-alert; empty is not completion', () => {
  const value = store(true);
  assert.equal(value.herdr('s1', 'claude', 'blocked', 1)[0].kind, 'blocked');
  assert.deepEqual(value.herdr('s1', undefined, undefined, 2, 'unavailable'), []);
  assert.equal(value.views()[0].state, 'unknown');
  assert.deepEqual(value.herdr('s1', 'claude', 'blocked', 3), []);
  assert.equal(value.views()[0].state, 'blocked');
  assert.deepEqual(value.herdr('s1', undefined, undefined, 4), []);
  assert.equal(value.views()[0].state, 'unknown');
  assert.deepEqual(value.herdr('s1', 'claude', 'done', 5), []);
  assert.deepEqual(native(value, 'blocked'), []); // observer cannot inject native status into herdr
});

test('closing scope removes cards/unread and ignores in-flight results', () => {
  const value = store(true);
  value.herdr('s1', 'codex', 'working', 1);
  value.herdr('s1', 'codex', 'done', 2);
  value.sync([]);
  assert.deepEqual(value.views(), []);
  assert.deepEqual(value.herdr('s1', 'codex', 'blocked', 3), []);
});

test('the same herdr pane has one identity across observe/control tabs but not across users', () => {
  const observe = { id: 'o', profileId: 'p', user: 'alice', herdrPane: 'w1:p1', herdrMode: 'observe', state: 'connected' };
  const control = { ...observe, id: 'c', herdrMode: 'control' };
  assert.equal(monitorSessionKey(observe), monitorSessionKey(control));
  assert.deepEqual(uniqueMonitorSessions([observe, control]).map(s => s.id), ['c']);
  assert.deepEqual(uniqueMonitorSessions([observe, { ...control, state: 'closed' }]).map(s => s.id), ['o']);
  assert.equal(uniqueMonitorSessions([observe, { ...control, user: 'bob' }]).length, 2);
});

test('a new run removes previous child failures rather than leaving a task permanently blocked', () => {
  const value = store();
  native(value, 'working');
  native(value, 'error', { id: 'test' });
  native(value, 'done');
  native(value, 'working');
  assert.equal(value.views()[0].state, 'working');
  assert.equal(value.views()[0].records, 1);
});

test('wire observers see each new chunk exactly once, independent of terminal mount/replay', () => {
  const bus = new SessionBus();
  let observed = 0;
  let displayed = 0;
  const stop = bus.observeOutput(() => observed++);
  bus.push('s1', new Uint8Array([1]));
  bus.attach('s1', () => displayed++);
  bus.detach('s1');
  bus.push('s1', new Uint8Array([2]));
  bus.attach('s1', () => displayed++);
  assert.equal(observed, 2);
  assert.equal(displayed, 2);
  stop();
  bus.push('s1', new Uint8Array([3]));
  assert.equal(observed, 2);
  assert.equal(displayed, 3);
});
