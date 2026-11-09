export const timestamp = value => value == null ? NaN : typeof value === 'number' ? value : Date.parse(value);
const statuses = ['pending', 'running', 'waiting', 'failed', 'completed', 'unknown'];
function check(condition) { if (!condition) throw new Error('Invalid progress data'); }
function string(value, fallback = '', max = 2000) {
  if (value == null) return fallback;
  check(typeof value === 'string' && value.length <= max);
  return value;
}
function date(value) {
  if (value == null) return null;
  check((typeof value === 'number' || typeof value === 'string') && Number.isFinite(timestamp(value)) && Number.isFinite(new Date(timestamp(value)).getTime()));
  return value;
}
function status(value) { check(value == null || statuses.includes(value)); return value ?? 'unknown'; }
export function normalizeWorkspace(value) {
  if (value == null) return null;
  check(typeof value === 'object' && !Array.isArray(value));
  const cwd = string(value.cwd, '', 8192); check(cwd.trim().length > 0);
  check(['primary', 'worktree', 'not-git', 'unavailable'].includes(value.checkoutKind));
  return { cwd, repoRoot: value.repoRoot == null ? null : string(value.repoRoot, '', 8192),
    branch: value.branch == null ? null : string(value.branch), commit: value.commit == null ? null : string(value.commit),
    checkoutKind: value.checkoutKind, observedAt: date(value.observedAt) };
}
export function normalizeTaskIndex(input) {
  check(input && Array.isArray(input.tasks) && input.tasks.length <= 2000);
  const ids = new Set();
  return input.tasks.map(task => {
    check(task && typeof task.id === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(task.id) && !ids.has(task.id));
    ids.add(task.id);
    const title = string(task.title); check(title.trim().length > 0);
    check(task.agentCount == null || (Number.isInteger(task.agentCount) && task.agentCount >= 0));
    check(task.unavailable == null || typeof task.unavailable === 'boolean');
    check(task.attention == null || ['failed', 'waiting'].includes(task.attention));
    return { id: task.id, title, status: status(task.status), startedAt: date(task.startedAt), endedAt: date(task.endedAt),
      workspace: normalizeWorkspace(task.workspace), agentCount: task.agentCount ?? null, attention: task.attention ?? null, unavailable: task.unavailable ?? false };
  });
}
export function initialTaskId(tasks, search) {
  const requested = new URLSearchParams(search).get('task');
  return tasks.find(task => task.id === requested)?.id ?? tasks[0]?.id ?? null;
}
export function createTaskSelection() {
  let current = null, revision = 0;
  return {
    select(id) { current = id; return { id, revision: ++revision }; },
    isCurrent(token) { return token.id === current && token.revision === revision; }
  };
}
export function normalizeProgress(input) {
  check(input && typeof input === 'object' && !Array.isArray(input));
  const title = string(input.title); check(title.trim().length > 0);
  const phases = input.phases ?? [], agents = input.agents ?? [], events = input.events ?? [];
  check(Array.isArray(phases) && phases.length <= 32 && Array.isArray(agents) && agents.length <= 64 && Array.isArray(events) && events.length <= 500);
  let itemCount = 0;
  const item = (value, depth = 0) => {
    check(value && depth < 8 && ++itemCount <= 500);
    const name = string(value.name); check(name.length > 0);
    const children = value.children;
    check(children == null || Array.isArray(children));
    return { name, status: status(value.status), ...(children?.length ? { children: children.map(child => item(child, depth + 1)) } : {}) };
  };
  const ids = new Set();
  const normalizedAgents = agents.map(agent => {
    check(agent && typeof agent.id === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(agent.id) && !ids.has(agent.id)); ids.add(agent.id);
    const name = string(agent.name); check(name.length > 0);
    check(agent.parentId == null || typeof agent.parentId === 'string');
    check(agent.launchMethod == null || ['session', 'command', 'subagent'].includes(agent.launchMethod));
    return { id: agent.id, name, role: string(agent.role), initials: name.slice(0, 1), parentId: agent.parentId ?? null, launchMethod: agent.launchMethod ?? null,
      model: agent.model == null ? null : string(agent.model), status: status(agent.status), current: string(agent.current), reason: string(agent.reason),
      workspace: normalizeWorkspace(agent.workspace), startedAt: date(agent.startedAt), endedAt: date(agent.endedAt), deliverables: [] };
  });
  const normalizedPhases = phases.map(phase => {
    check(phase && Array.isArray(phase.items)); const name = string(phase.name); check(name.length > 0);
    return { name, items: phase.items.map(value => item(value)) };
  });
  const phase = input.phase ?? 0;
  check(Number.isInteger(phase) && phase >= 0 && (phases.length ? phase < phases.length : phase === 0));
  return { id: string(input.id), title, summary: string(input.summary), status: status(input.status), reason: string(input.reason),
    workspace: normalizeWorkspace(input.workspace), startedAt: date(input.startedAt), endedAt: date(input.endedAt), phase, phases: normalizedPhases, agents: normalizedAgents,
    events: events.map((event, index) => {
      check(event && (event.agentId == null || typeof event.agentId === 'string'));
      const title = string(event.title); check(title.length > 0);
      const kind = event.kind ?? 'progress'; check(['progress', 'milestone', 'warning', 'error', 'tool'].includes(kind));
      return { id: `event-${index}`, agentId: event.agentId ?? null, at: date(event.at), title, detail: string(event.detail), kind };
    }) };
}
export function duration(ms) {
  if (!Number.isFinite(ms)) return '—';
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}秒`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}分 ${String(seconds % 60).padStart(2, '0')}秒`;
  return `${Math.floor(minutes / 60)}時間 ${String(minutes % 60).padStart(2, '0')}分`;
}
export const elapsed = (entity, now) => {
  if (entity.startedAt == null || (['completed', 'failed'].includes(entity.status) && entity.endedAt == null)) return NaN;
  return Math.max(0, timestamp(entity.endedAt ?? now) - timestamp(entity.startedAt));
};
export function agentHealth(agent) {
  const labels = { pending: ['未着手', 'neutral'], running: ['実行中', 'running'], waiting: ['確認待ち', 'warning'], failed: ['失敗', 'danger'], completed: ['完了', 'good'], unknown: ['未報告', 'neutral'] };
  const [label, tone] = labels[agent.status] ?? labels.unknown;
  return { label, tone, reason: ['waiting', 'failed'].includes(agent.status) ? agent.reason : '' };
}
// List labels and filters use the same reported state, never report age.
export function taskListState(task) {
  if (task.unavailable) return { label: '確認が必要', tone: 'warning', category: 'attention' };
  if (task.attention && !['completed', 'failed', 'waiting'].includes(task.status)) {
    return { label: '確認が必要', tone: task.attention === 'failed' ? 'danger' : 'warning', category: 'attention' };
  }
  const health = agentHealth(task);
  const category = ['waiting', 'failed'].includes(task.status) ? 'attention'
    : task.status === 'completed' ? 'completed' : task.status === 'running' ? 'running' : 'other';
  return { ...health, category };
}
export function filterTasks(tasks, filter = 'all') {
  return tasks.filter(task => filter === 'all' || taskListState(task).category === filter);
}
export function taskHealth(run) {
  const reported = agentHealth(run);
  if (['completed', 'failed', 'waiting'].includes(run.status)) return { ...reported, ...(run.reason ? { title: reported.label, description: run.reason } : {}) };
  const issue = run.agents.find(agent => agent.status === 'failed') ?? run.agents.find(agent => agent.status === 'waiting');
  if (issue) { const state = agentHealth(issue); return { label: '確認が必要', tone: state.tone, title: `${issue.name}：${state.label}`, description: state.reason, agentId: issue.id }; }
  return reported;
}
export function workForPhase(run, index) {
  const visit = item => ({ ...item, status: item.status ?? 'pending', ...(item.children ? { children: item.children.map(visit) } : {}) });
  return (run.phases[index]?.items ?? []).map(visit);
}
export function planCounts(run, phaseIndex = null) {
  let completed = 0, total = 0;
  const count = item => {
    if (item.children?.length) { item.children.forEach(count); return; }
    total++;
    if (item.status === 'completed') completed++;
  };
  const indices = phaseIndex == null ? run.phases.map((_, index) => index) : [phaseIndex];
  indices.forEach(index => workForPhase(run, index).forEach(count));
  return { completed, total };
}
export function phaseState(run, index) {
  const leaves = [];
  const visit = item => item.children?.length ? item.children.forEach(visit) : leaves.push(item.status);
  workForPhase(run, index).forEach(visit);
  if (!leaves.length) return 'unknown';
  if (leaves.every(status => status === 'completed')) return 'completed';
  return ['failed', 'waiting', 'running', 'pending'].find(status => leaves.includes(status)) ?? 'unknown';
}
export function phaseCounts(run) {
  return { completed: run.phases.filter((_, index) => phaseState(run, index) === 'completed').length, total: run.phases.length };
}
export function eventsFor(run, agentId, limit = 30) {
  return run.events.filter(event => agentId == null || event.agentId === agentId)
    .map((event, order) => ({ event, order }))
    .sort((a, b) => timestamp(b.event.at) - timestamp(a.event.at) || b.order - a.order)
    .slice(0, limit).map(item => item.event);
}
export function visibleEvents(run, filter = 'all', limit = 20) {
  return eventsFor(run, null, run.events.length)
    .filter(event => filter === 'all' || (filter === 'milestone' ? event.kind === 'milestone' : ['warning', 'error'].includes(event.kind)))
    .slice(0, limit);
}
export function participantDepth(agent, agents) {
  const seen = new Set([agent.id]);
  let depth = 0, parent = agents.find(item => item.id === agent.parentId);
  while (parent && !seen.has(parent.id)) {
    seen.add(parent.id); depth++; parent = agents.find(item => item.id === parent.parentId);
  }
  return Math.min(depth, 4);
}
