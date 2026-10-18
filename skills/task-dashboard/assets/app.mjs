import { normalizeProgress, agentHealth, taskHealth, workForPhase, planCounts, phaseCounts, phaseState, eventsFor, visibleEvents, duration, elapsed, timestamp, participantDepth } from './state.mjs';
import { escapeHtml as e, timeOf } from './format.mjs';

const $ = id => document.getElementById(id);
let run = null;
let selectedAgent = null;
let selectedPhase = null;
let filter = 'all';
let connected = false;
let hasConnected = false;
let requestActive = false;
const clock = () => Date.now();
const durationTag = entity => `<span data-status="${e(entity.status)}" data-start="${e(timestamp(entity.startedAt))}"${entity.endedAt == null ? '' : ` data-end="${e(timestamp(entity.endedAt))}"`}></span>`;
const badge = (label, tone) => `<span class="status ${e(tone)}"><span class="tiny-dot" aria-hidden="true"></span>${e(label)}</span>`;
const executionBadge = agent => { const health = agentHealth(agent); return badge(health.label, health.tone).replace('class="tiny-dot"', agent.status === 'running' ? 'class="agent-spinner"' : 'class="tiny-dot"'); };
const launchLabels = { session: 'メイン', subagent: 'サブエージェント', command: 'コマンド起動' };
const htmlCache = new Map();
function replace(id, html) {
  if (htmlCache.get(id) === html) return;
  const host = $(id);
  const activeId = host.contains(document.activeElement) ? document.activeElement.id : null;
  const openIds = [...host.querySelectorAll('details[open][id]')].map(element => element.id);
  host.innerHTML = html;
  htmlCache.set(id, html);
  for (const openId of openIds) if ($(openId)) $(openId).open = true;
  if (activeId && $(activeId)) $(activeId).focus({ preventScroll: true });
}
function updateConnection(ok) {
  const changed = connected !== ok;
  connected = ok;
  $('connection-notice').hidden = ok;
  $('connection-notice').className = 'connection-notice';
  if (!ok) $('connection-notice').textContent = hasConnected
    ? '進捗データを読み込めません。最後に読み込んだ内容を表示しています。'
    : '進捗データを読み込めません。表示用フォルダーの progress.json を確認してください。';
  if (ok && hasConnected && changed) $('announcement').textContent = '進捗データの読み込みが復旧しました。';
  if (ok) hasConnected = true;
}
function renderOverview() {
  const health = taskHealth(run);
  replace('overview', `
    <div class="task-heading"><div><h1>${e(run.title)}</h1>${run.summary ? `<p class="task-subtitle">${e(run.summary)}</p>` : ''}</div>${badge(health.label, health.tone)}</div>
    <div class="run-summary"><div class="summary-item">経過時間<strong>${durationTag(run)}</strong></div><div class="summary-item">エージェント<strong>${run.agents.length}</strong></div></div>
    ${health.title ? `<div class="health-banner ${e(health.tone)}"><span class="health-symbol" aria-hidden="true">!</span><div><strong>${e(health.title)}</strong><p>${e(health.description)}</p></div>${health.agentId ? `<button id="inspect-alert" data-agent="${e(health.agentId)}" type="button">担当を確認</button>` : ''}</div>` : ''}`);
  $('start-time').textContent = Number.isFinite(timestamp(run.startedAt)) ? timeOf(timestamp(run.startedAt)) : '—';
  $('sidebar-title').textContent = run.title;
  $('run-id').textContent = run.id;
  $('breadcrumb-run').textContent = run.title;
  document.title = `${run.title} — Taskroom`;
}
function renderWork(items) {
  const states = { completed: ['✓', '完了'], running: ['●', '実行中'], pending: ['○', '未着手'], waiting: ['!', '待機中'], failed: ['!', '失敗'], unknown: ['—', '未報告'] };
  return `<ul class="phase-work-list">${items.map(item => {
    const status = states[item.status] ? item.status : 'pending';
    const [icon, label] = states[status];
    return `<li class="phase-work-item ${status}">${item.children?.length ? `<strong>${e(item.name)}</strong>${renderWork(item.children)}` : `<span class="work-symbol" aria-hidden="true">${icon}</span><span>${e(item.name)}</span><span class="work-state">${label}</span>`}</li>`;
  }).join('')}</ul>`;
}
function renderPhases() {
  const counts = phaseCounts(run);
  $('task-count').textContent = counts.total ? `${counts.completed} / ${counts.total} フェーズ完了` : '';
  replace('phases', run.phases.map((phase, index) => {
    const state = phaseState(run, index);
    const done = state === 'completed';
    const current = !done && index === run.phase;
    const label = done ? '完了' : ['waiting', 'failed', 'running'].includes(state) ? agentHealth({ status: state }).label : current ? '現在のフェーズ' : state === 'pending' ? '未着手' : '未報告';
    return `<button id="phase-${index}" class="phase-button ${done ? 'done' : ''} ${current ? 'current' : ''}" type="button" data-phase="${index}" aria-pressed="${index === selectedPhase}" ${current ? 'aria-current="step"' : ''}><span class="phase-number" aria-hidden="true">${done ? '✓' : index + 1}</span><span class="phase-label">${e(phase.name)}<small>${label}</small></span></button>`;
  }).join(''));
  const phase = run.phases[selectedPhase];
  const work = planCounts(run, selectedPhase);
  replace('phase-detail', phase
    ? `<div class="phase-detail-heading"><h3>${e(phase.name)}の作業</h3>${work.total ? `<span class="phase-work-count">${work.completed} / ${work.total} 作業完了</span>` : ''}</div>${phase.items?.length ? renderWork(workForPhase(run, selectedPhase)) : '<p class="empty-history">作業の内訳はまだありません。</p>'}`
    : '<p class="empty-history">実行計画の登録を待っています。</p>');
}
function renderAgents() {
  $('agent-count').textContent = run.agents.length;
  replace('agent-list', run.agents.length ? run.agents.map(agent => {
    const depth = participantDepth(agent, run.agents);
    return `<button id="agent-${e(agent.id)}" type="button" class="agent-row ${depth ? 'child' : ''}" data-depth="${depth}" data-agent="${e(agent.id)}" aria-pressed="${agent.id === selectedAgent}" aria-controls="inspector"><div class="agent-top"><span class="avatar ${agent.launchMethod === 'session' ? 'manager' : ''}" aria-hidden="true">${e(agent.initials || agent.name.slice(0, 1))}</span><div><div class="agent-name">${e(agent.name)}</div><div class="agent-role">${agent.role !== agent.name ? e(agent.role) : ''}${agent.launchMethod === 'command' ? '<span class="launch-label">コマンド起動</span>' : ''}</div></div>${executionBadge(agent)}</div><div class="agent-model"><span class="model-symbol" aria-hidden="true">◇</span>${e(agent.model || 'モデル未報告')}<span class="agent-age">経過 ${durationTag(agent)}</span></div>${agent.current || agent.tool ? `<div class="agent-current">${e(agent.current || agent.tool)}</div>` : ''}</button>`;
  }).join('') : '<p class="empty-history">担当はまだ登録されていません。</p>');
}
function eventTime(event) {
  const at = timestamp(event.at);
  return Number.isFinite(at) ? `<time datetime="${new Date(at).toISOString()}">${timeOf(at)}</time>` : '<time>—</time>';
}
function renderInspector() {
  const agent = run.agents.find(item => item.id === selectedAgent);
  if (!agent) {
    replace('inspector', '<h2 id="inspector-title">エージェントの詳細</h2><p class="empty-history">担当を選ぶと、作業と履歴を確認できます。</p>');
    return;
  }
  const health = agentHealth(agent);
  const history = eventsFor(run, agent.id, 12);
  replace('inspector', `<div class="inspector-header"><span class="avatar ${agent.launchMethod === 'session' ? 'manager' : ''}" aria-hidden="true">${e(agent.initials || agent.name.slice(0, 1))}</span><div><h2 id="inspector-title" tabindex="-1">${e(agent.name)}</h2>${agent.role && agent.role !== agent.name ? `<p>${e(agent.role)}</p>` : ''}</div>${executionBadge(agent)}</div>
    <dl class="inspector-meta"><div><dt>モデル</dt><dd>${e(agent.model || '未報告')}</dd></div><div><dt>経過時間</dt><dd>${durationTag(agent)}</dd></div><div><dt>起動方法</dt><dd>${e(launchLabels[agent.launchMethod] || '未報告')}</dd></div></dl>
    <div class="work-label">${agent.endedAt != null || ['completed', 'failed'].includes(agent.status) ? '最終報告' : '現在の処理'}</div><p class="current-work">${e(agent.current || agent.tool || '処理の報告を待っています。')}</p>
    ${health.reason ? `<p class="agent-issue ${e(health.tone)}">${e(health.reason)}</p>` : ''}
    <div class="history-heading"><h3>このエージェントの履歴</h3><span>直近 ${history.length} 件</span></div><ol class="agent-history">${history.map(event => `<li>${eventTime(event)}<div class="history-item"><strong>${e(event.title)}</strong>${event.detail ? `<p>${e(event.detail)}</p>` : ''}</div></li>`).join('')}</ol>
    ${history.length ? '' : '<p class="empty-history">履歴はまだありません。</p>'}
    ${agent.deliverables?.length ? `<details class="deliverables" id="deliverables"><summary id="deliverables-toggle">担当する成果物を確認</summary><ul>${agent.deliverables.map(item => `<li>${e(item)}</li>`).join('')}</ul></details>` : ''}`);
}
function renderActivity() {
  const kinds = { milestone: '節目', progress: '進捗', warning: '確認', error: 'エラー', tool: '処理' };
  const events = visibleEvents(run, filter);
  replace('activity', `<div class="activity-list">${events.length ? events.map(event => {
    const agent = run.agents.find(item => item.id === event.agentId);
    return `<div class="activity-row">${eventTime(event)}<span class="activity-actor">${e(agent?.name || (event.agentId ? event.agentId : 'タスク'))}</span><div class="activity-message"><strong>${e(event.title)}</strong>${event.detail ? `<p>${e(event.detail)}</p>` : ''}</div><span class="event-kind ${e(event.kind)}">${e(kinds[event.kind] || '記録')}</span></div>`;
  }).join('') : '<p class="empty-history">この条件に一致する履歴はありません。</p>'}</div>`);
}
function renderAll() {
  if (!run) return;
  renderOverview(); renderPhases(); renderAgents(); renderInspector(); renderActivity(); updateClock();
}
function updateClock() {
  for (const element of document.querySelectorAll('[data-start]')) {
    const value = duration(elapsed({ startedAt: Number(element.dataset.start), endedAt: element.dataset.end == null ? null : Number(element.dataset.end), status: element.dataset.status }, clock()));
    if (element.textContent !== value) element.textContent = value;
  }
}
function receive(next) {
  const normalized = normalizeProgress(next);
  const previous = run;
  const wasFollowing = selectedPhase == null || selectedPhase === previous?.phase;
  run = normalized;
  if (!run.agents.some(agent => agent.id === selectedAgent)) selectedAgent = run.agents[0]?.id ?? null;
  if (wasFollowing || selectedPhase >= run.phases.length) selectedPhase = run.phases.length ? Math.min(Math.max(run.phase ?? 0, 0), run.phases.length - 1) : null;
  updateConnection(true);
  renderAll();
}
async function poll() {
  if (requestActive) return;
  requestActive = true;
  try {
    const response = await fetch('./progress.json', { cache: 'no-store', signal: AbortSignal.timeout(3500) });
    if (!response.ok) throw new Error('Snapshot unavailable');
    receive(await response.json());
  } catch {
    updateConnection(false);
  } finally {
    requestActive = false;
    setTimeout(poll, 1000);
  }
}
$('activity-filter').addEventListener('change', event => { filter = event.target.value; if (run) renderActivity(); });
$('main').addEventListener('click', event => {
  if (!run) return;
  const agentButton = event.target.closest('[data-agent]');
  if (agentButton) {
    const agent = run.agents.find(item => item.id === agentButton.dataset.agent);
    if (!agent) return;
    selectedAgent = agent.id;
    renderAgents(); renderInspector(); updateClock();
    $('announcement').textContent = `${agent.name}の詳細を表示しました。`;
    if (agentButton.id === 'inspect-alert' || window.matchMedia('(max-width: 680px)').matches) $('inspector-title').focus();
  }
  const phaseButton = event.target.closest('[data-phase]');
  if (phaseButton) { selectedPhase = Number(phaseButton.dataset.phase); renderPhases(); }
});
setInterval(() => {
  if (!run) return;
  updateClock();
}, 1000);
poll();
