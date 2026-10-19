import test from 'node:test';
import assert from 'node:assert/strict';

const flush = async () => { for (let i = 0; i < 8; i++) await new Promise(resolve => setImmediate(resolve)); };
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

test('shared viewer isolates delayed snapshots, failed reports and task selection', async () => {
  const globals = ['document', 'window', 'fetch', 'setTimeout', 'clearTimeout', 'setInterval'];
  const originals = Object.fromEntries(globals.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const nodes = new Map(), timers = new Map(), calls = [];
  let timerId = 0;
  function node(id) {
    if (!nodes.has(id)) nodes.set(id, { id, innerHTML: '', textContent: '', hidden: false, value: 'all', listeners: {},
      contains: () => false, querySelectorAll: () => [], addEventListener(type, callback) { this.listeners[type] = callback; } });
    return nodes.get(id);
  }
  const a = deferred(), b = deferred();
  let index = { tasks: [{ id: 'b', title: 'B', status: 'running', attention: 'failed' }, { id: 'a', title: 'A' }] };
  let bResult = b.promise;
  const response = body => ({ ok: true, json: async () => body });
  globalThis.document = { documentElement: { dataset: { dashboardMode: 'shared' } }, getElementById: node, querySelectorAll: () => [] };
  globalThis.window = { location: { search: '?task=a' }, matchMedia: () => ({ matches: false }) };
  globalThis.setTimeout = (callback, delay) => { const id = ++timerId; timers.set(id, { callback, delay }); return id; };
  globalThis.clearTimeout = id => timers.delete(id);
  globalThis.setInterval = () => 0;
  globalThis.fetch = async url => {
    calls.push(url);
    if (url === './api/tasks') return response(index);
    if (url === './tasks/a/progress.json') return a.promise;
    if (url === './tasks/b/progress.json') return bResult;
    throw new Error(`Unexpected request ${url}`);
  };
  const clickTask = id => node('task-navigation').listeners.click({ target: { closest: () => ({ dataset: { task: id } }) } });
  async function tick(delay) {
    const entry = [...timers].find(([, timer]) => timer.delay === delay);
    assert.ok(entry, `expected ${delay}ms poll`);
    timers.delete(entry[0]); entry[1].callback(); await flush();
  }
  try {
    await import(`../skills/task-dashboard/assets/app.mjs?integration=${Date.now()}`);
    await flush();
    assert.ok(calls.includes('./tasks/a/progress.json'));
    clickTask('b');
    b.resolve(response({ title: 'Task B', workspace: { cwd: '/tmp/B', branch: 'feature/b', checkoutKind: 'primary' }, agents: [{ id: 'shared', name: 'B worker', workspace: { cwd: '/tmp/<work>', repoRoot: '/tmp/<work>', branch: '<main>', checkoutKind: 'worktree' } }], events: [{ agentId: 'shared', title: 'Only B history' }] }));
    await flush();
    a.resolve(response({ title: 'Task A', agents: [{ id: 'shared', name: 'A worker' }], events: [{ agentId: 'shared', title: 'Only A history' }] }));
    await flush();
    assert.match(node('overview').innerHTML, /Task B/);
    assert.doesNotMatch(node('inspector').innerHTML, /Only A history|A worker/);
    assert.match(node('inspector').innerHTML, /Only B history/);
    assert.match(node('inspector').innerHTML, /\/tmp\/&lt;work&gt;/);
    assert.match(node('agent-list').innerHTML, /&lt;main&gt;/);
    assert.match(node('agent-list').innerHTML, /checkout-tag">worktree/);
    assert.match(node('overview').innerHTML, /feature\/b/);
    index = { tasks: [...index.tasks, { id: 'c', title: 'New C' }] };
    await tick(5000);
    assert.match(node('task-list').innerHTML, /New C/);
    assert.match(node('task-list').innerHTML, /task-state danger">確認が必要/);
    assert.match(node('task-list').innerHTML, /data-task="b" aria-current="page"/);
    assert.equal(calls.some(url => url.includes('/c/')), false);
    bResult = Promise.resolve(response({ title: 'Malformed B', agents: 'broken' }));
    await tick(1000);
    assert.equal(node('connection-notice').hidden, false);
    assert.match(node('overview').innerHTML, /Task B/);
    assert.doesNotMatch(node('overview').innerHTML, /Task A|Malformed B/);
    index = { tasks: index.tasks.map(task => task.id === 'b' ? { ...task, attention: 'waiting' } : task) };
    await tick(5000);
    assert.match(node('task-list').innerHTML, /task-state warning">確認が必要/);
    index = { tasks: index.tasks.map(task => task.id === 'b' ? { ...task, status: 'completed', attention: 'failed' } : task) };
    await tick(5000);
    assert.match(node('task-list').innerHTML, /task-state good">完了/);
    index = { tasks: 'broken' };
    await tick(5000);
    assert.equal(node('index-notice').hidden, false);
    assert.match(node('task-list').innerHTML, /New C/);
    assert.match(node('overview').innerHTML, /Task B/);
  } finally {
    for (const key of globals) {
      if (originals[key]) Object.defineProperty(globalThis, key, originals[key]);
      else delete globalThis[key];
    }
  }
});
