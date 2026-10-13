// Phase 3: live view of one run, with the doctrine ticker.
//
// The rhetoric is composed server-side by DoctrineNarrator and arrives with each event, so the
// page never re-implements the templates and cannot drift from them.
//
// Everything below builds DOM nodes and sets textContent. The ledger contains raw model output
// and diff text, so it is never assigned to innerHTML.
(() => {
  'use strict';

  const IDLE_MS = 20_000;
  const TICKER_MAX = 60;
  const EPIGRAPH_MS = 45_000;

  const DASHBOARD_LABELS = {
    approvalsHeading: 'Next action',
    orderPaperHeading: 'Tasks',
    noPlan: 'No tasks have been planned yet.',
    dependencyUnit: 'task',
  };

  // Mirrors isTerminal() on the server. 'awaiting_acceptance' and 'remediation' are absent on
  // purpose: the swarm has paused, but the run is still going somewhere.
  const TERMINAL = new Set(['completed', 'failed', 'stopped', 'terminated_incomplete']);

  // How long to keep a finished run's stream open waiting for a re-voiced closing statement.
  // Longer than the server's own model timeout, so the frame arrives first in every case where
  // it is going to arrive at all; this is only the backstop for a server that never answers.
  const STATEMENT_WAIT_MS = 60_000;

  const runListEl = document.getElementById('run-list');
  const detailEl = document.getElementById('detail');
  const connEl = document.getElementById('conn');
  const statusEl = document.getElementById('run-status');
  const elapsedEl = document.getElementById('elapsed');
  const costTextEl = document.getElementById('cost-text');
  const costFillEl = document.getElementById('cost-fill');
  const tickerEl = document.getElementById('ticker');
  const epigraphQuoteEl = document.getElementById('epigraph-quote');
  const epigraphSourceEl = document.getElementById('epigraph-source');
  const template = document.getElementById('run-detail-template');
  const galleryEl = document.getElementById('gallery');
  const singleViewEl = document.getElementById('single-view');
  const viewToggleEl = document.getElementById('view-toggle');
  const newsreelEl = document.getElementById('newsreel');
  const newsreelVideoEl = document.getElementById('newsreel-video');
  const newsreelCaptionEl = document.getElementById('newsreel-caption');
  const newsreelPauseEl = document.getElementById('newsreel-pause');

  const GALLERY_MAX = 6;
  const GALLERY_LINES = 7;

  const view = {
    runId: null,
    strategy: null,
    state: null,
    /** [{ entry, line }] in ledger order. */
    records: [],
    workers: new Map(),
    statement: null,
    closingAnnounced: false,
    raw: false,
  };

  let stream = null;
  let refs = null;
  let epigraphs = null;
  let epigraphIndex = 0;
  let statementTimer = null;

  // ---------------------------------------------------------------- utilities

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  function clear(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
  }

  const money = (v) => `$${Number(v ?? 0).toFixed(4)}`;
  const words = (v) => String(v ?? '').replace(/_/g, ' ');

  function clockTime(iso) {
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? String(iso) : d.toLocaleTimeString();
  }

  function duration(ms) {
    if (!Number.isFinite(ms) || ms < 0) return '—';
    const s = Math.floor(ms / 1000);
    const ss = String(s % 60).padStart(2, '0');
    const h = Math.floor(s / 3600);
    if (h > 0) return `${h}:${String(Math.floor(s / 60) % 60).padStart(2, '0')}:${ss}`;
    return `${String(Math.floor(s / 60)).padStart(2, '0')}:${ss}`;
  }

  async function getJson(path) {
    const res = await fetch(path, { headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    return res.json();
  }

  function showError(node, err) {
    clear(node);
    node.appendChild(el('p', 'error', `Could not reach the swarm: ${err.message}`));
  }

  // ----------------------------------------------------------------- palette

  function setStrategy(strategy) {
    if (view.strategy === strategy) return;
    view.strategy = strategy;
    // Drives the whole page's accent colour from CSS.
    document.body.dataset.strategy = strategy || '';
    epigraphIndex = 0;
    renderEpigraph();
  }

  // ------------------------------------------------------------ newsreel wall
  //
  // A handful of muted archival clips in the right rail, independent of which doctrine is on
  // screen — see assets/newsreel/credits.json for what's actually licensed to be here. One clip
  // plays at a time; the client advances to the next on the video's own `ended` event rather than
  // a timer, since each clip already carries its own natural duration.

  const newsreel = (() => {
    const state = { clips: [], index: 0, paused: false };
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

    function showClip(index) {
      const clip = state.clips[index];
      if (!clip) return;
      state.index = index;
      newsreelVideoEl.src = clip.url;
      newsreelCaptionEl.textContent = clip.credit ? `${clip.title} — ${clip.credit}` : clip.title;
      if (!state.paused) void newsreelVideoEl.play().catch(() => {});
    }

    newsreelVideoEl.addEventListener('ended', () => {
      showClip((state.index + 1) % state.clips.length);
    });

    newsreelPauseEl.addEventListener('click', () => {
      state.paused = !state.paused;
      newsreelPauseEl.textContent = state.paused ? 'Play' : 'Pause';
      newsreelPauseEl.setAttribute('aria-pressed', String(state.paused));
      if (state.paused) newsreelVideoEl.pause();
      else void newsreelVideoEl.play().catch(() => {});
    });

    return {
      async load() {
        let manifest;
        try {
          manifest = await getJson('/api/newsreel');
        } catch {
          return; // A missing reel is cosmetic; the dashboard works without it.
        }
        state.clips = manifest.clips || [];
        if (state.clips.length === 0) return;

        newsreelEl.hidden = false;
        // A viewer who asked the OS for less motion gets the reel paused on its first frame,
        // one tap away rather than launched at them.
        state.paused = reducedMotion.matches;
        newsreelPauseEl.textContent = state.paused ? 'Play' : 'Pause';
        newsreelPauseEl.setAttribute('aria-pressed', String(state.paused));
        showClip(0);
      },
    };
  })();

  // ------------------------------------------------------------------ header

  function setConnection(state) {
    connEl.dataset.state = state;
    const labels = { live: 'Events connected', connecting: 'Connecting events', reconnecting: 'Reconnecting events', idle: view.runId ? 'Saved record' : 'No run selected', error: 'Server unavailable', loading: 'Loading runs' };
    connEl.textContent = labels[state] || state;
    connEl.title = 'Connection to dashboard events; run progress is shown separately.';
  }

  function renderHeader() {
    const state = view.state;
    if (!state) {
      statusEl.textContent = '—';
      statusEl.className = 'status';
      elapsedEl.textContent = '—';
      costTextEl.textContent = '—';
      costFillEl.style.transform = 'scaleX(0)';
      return;
    }

    statusEl.textContent = `Run: ${words(state.status)}`;
    statusEl.className = `status ${state.status}`;

    elapsedEl.title = 'Time since run creation, including pauses and waiting';
    const end = TERMINAL.has(state.status) ? new Date(state.updatedAt).getTime() : Date.now();
    elapsedEl.textContent = duration(end - new Date(state.createdAt).getTime());

    costTextEl.textContent = `${money(state.costUsd)} / ${money(state.budgetUsd)}`;
    const pct = state.budgetUsd > 0 ? Math.min(100, (state.costUsd / state.budgetUsd) * 100) : 0;
    // scaleX, not width: animating width thrashes layout, transform doesn't.
    costFillEl.style.transform = `scaleX(${pct / 100})`;
    costFillEl.dataset.level = pct >= 90 ? 'critical' : pct >= 70 ? 'warn' : 'ok';
  }

  setInterval(() => {
    if (view.state && !TERMINAL.has(view.state.status)) renderHeader();
  }, 1000);

  // ------------------------------------------------------------------ ticker

  function tickerRecords() {
    return view.records.filter((r) => r.line && r.line.text);
  }

  function tickerNode(record) {
    const li = el('li', `ticker-line tone-${record.line.tone}`);
    li.appendChild(el('span', 'ticker-time', clockTime(record.entry.ts)));
    li.appendChild(el('span', 'ticker-text', record.line.text));
    return li;
  }

  function renderTicker() {
    clear(tickerEl);
    const records = tickerRecords().slice(-TICKER_MAX);

    if (records.length === 0) {
      tickerEl.appendChild(el('li', 'ticker-line empty', 'No run events to display yet.'));
      return;
    }
    for (const record of records) tickerEl.appendChild(tickerNode(record));
    tickerEl.scrollTop = tickerEl.scrollHeight;
  }

  function pushTicker(record) {
    if (!record.line || !record.line.text) return;

    const placeholder = tickerEl.querySelector('.empty');
    if (placeholder) tickerEl.removeChild(placeholder);

    const li = tickerNode(record);
    li.classList.add('entering');
    tickerEl.appendChild(li);
    while (tickerEl.children.length > TICKER_MAX) tickerEl.removeChild(tickerEl.firstChild);
    tickerEl.scrollTop = tickerEl.scrollHeight;
    requestAnimationFrame(() => li.classList.remove('entering'));
  }

  // --------------------------------------------------------------- epigraphs

  async function loadEpigraphs() {
    try {
      epigraphs = await getJson('/assets/epigraphs.json');
      renderEpigraph();
    } catch {
      // A missing epigraph file is cosmetic; the ticker is the substance.
    }
  }

  function renderEpigraph() {
    if (!epigraphs) return;
    const set = epigraphs[view.strategy] || [];
    if (set.length === 0) {
      epigraphQuoteEl.textContent = '';
      epigraphSourceEl.textContent = '';
      return;
    }
    const item = set[epigraphIndex % set.length];
    epigraphQuoteEl.textContent = item.quote;
    epigraphSourceEl.textContent = item.author ? `${item.author}, ${item.work}` : '';
  }

  setInterval(() => {
    if (!epigraphs || !view.strategy) return;
    epigraphIndex += 1;
    renderEpigraph();
  }, EPIGRAPH_MS);

  // ----------------------------------------------------------------- gallery
  //
  // Every run at once, side by side. Built for benchmark races, where the point is watching the
  // three traditions arrive at different answers to the same task at the same moment.

  const gallery = { active: false, panels: new Map() };

  function galleryPanel(summary) {
    let panel = gallery.panels.get(summary.runId);
    if (panel) return panel;

    const root = el('article', `gallery-card ${summary.strategy}`);
    root.appendChild(el('div', 'gallery-flag', summary.strategy));
    const head = el('header', 'gallery-head');
    const status = el('span', `status ${summary.status}`, words(summary.status));
    head.appendChild(status);
    root.appendChild(head);

    const goal = el('p', 'gallery-goal', summary.goal.split('\n')[0]);
    root.appendChild(goal);

    const meta = el('div', 'meta gallery-meta');
    root.appendChild(meta);

    const bar = el('span', 'budget-bar');
    const fill = el('span', 'budget-fill');
    bar.appendChild(fill);
    root.appendChild(bar);

    const lines = el('ol', 'gallery-ticker');
    // Terminal runs load with no backfill (the gallery only tails the live stream), so a settled
    // run would otherwise show as dead space between the spend gauge and the card's own edge.
    lines.appendChild(el('li', 'empty', 'No lines yet.'));
    root.appendChild(lines);

    // Clicking a panel drops back into the single-run view for that run. setView(false) does the
    // selecting itself, so point it at this run first rather than calling selectRun again after
    // it — two concurrent selectRun() calls race over `view` and the detail pane, and the one
    // that resolves last wins the render even when it is for the run the user did not click.
    root.addEventListener('click', () => {
      view.runId = summary.runId;
      setView(false);
    });

    panel = { root, status, goal, meta, fill, lines };
    gallery.panels.set(summary.runId, panel);
    galleryEl.appendChild(root);
    return panel;
  }

  function updateGalleryPanel(summary) {
    const panel = galleryPanel(summary);
    panel.status.textContent = words(summary.status);
    panel.status.className = `status ${summary.status}`;
    panel.goal.textContent = summary.goal.split('\n')[0];

    clear(panel.meta);
    panel.meta.appendChild(
      el('span', null, `${summary.taskCount} tasks · ${summary.workerCalls} calls · ${money(summary.costUsd)}`),
    );

    const pctSpent = summary.budgetUsd > 0 ? Math.min(100, (summary.costUsd / summary.budgetUsd) * 100) : 0;
    panel.fill.style.transform = `scaleX(${pctSpent / 100})`;
    panel.fill.dataset.level = pctSpent >= 90 ? 'critical' : pctSpent >= 70 ? 'warn' : 'ok';
  }

  function pushGalleryLine(runId, line) {
    const panel = gallery.panels.get(runId);
    if (!panel || !line || !line.text) return;
    const placeholder = panel.lines.querySelector('.empty');
    if (placeholder) panel.lines.removeChild(placeholder);
    const li = el('li', `ticker-line tone-${line.tone}`);
    li.appendChild(el('span', 'ticker-text', line.text));
    panel.lines.appendChild(li);
    while (panel.lines.children.length > GALLERY_LINES) panel.lines.removeChild(panel.lines.firstChild);
  }

  async function renderGallery() {
    try {
      const { runs } = await getJson('/api/runs');
      // Live runs first — they are the reason to be in this view at all.
      const ordered = runs.filter((run) => !hiddenRuns.has(run.runId)).sort((a, b) => {
        const liveA = TERMINAL.has(a.status) ? 1 : 0;
        const liveB = TERMINAL.has(b.status) ? 1 : 0;
        return liveA - liveB || b.createdAt.localeCompare(a.createdAt);
      });
      const shown = ordered.slice(0, GALLERY_MAX);
      const keep = new Set(shown.map((r) => r.runId));
      if (shown.length > 0) galleryEl.querySelector(':scope > .empty')?.remove();

      for (const [runId, panel] of gallery.panels) {
        if (!keep.has(runId)) {
          panel.root.remove();
          gallery.panels.delete(runId);
        }
      }
      for (const summary of shown) updateGalleryPanel(summary);

      if (shown.length === 0) {
        clear(galleryEl);
        gallery.panels.clear();
        galleryEl.appendChild(el('p', 'empty', 'No runs on record.'));
      }
    } catch (err) {
      showError(galleryEl, err);
    }
  }

  function setView(toGallery) {
    gallery.active = toGallery;
    galleryEl.hidden = !toGallery;
    singleViewEl.hidden = toGallery;
    viewToggleEl.textContent = toGallery ? 'Single run' : 'Compare runs';
    viewToggleEl.setAttribute('aria-pressed', String(toGallery));

    if (toGallery) {
      clear(galleryEl);
      gallery.panels.clear();
      // One stream for every run, rather than one per panel.
      openStream('all');
      renderGallery();
    } else if (view.runId) {
      selectRun(view.runId);
    } else {
      closeStream();
      refresh();
    }
  }

  viewToggleEl.addEventListener('click', () => setView(!gallery.active));

  // ---------------------------------------------------------------- run list

  let knownRuns = [];
  let runFilter = 'all';
  const HIDDEN_RUNS_KEY = 'political-swarm.hidden-runs';
  let hiddenRuns = new Set();
  try {
    const saved = JSON.parse(localStorage.getItem(HIDDEN_RUNS_KEY) || '[]');
    if (Array.isArray(saved)) hiddenRuns = new Set(saved.filter((id) => typeof id === 'string'));
  } catch {
    // Storage may be unavailable or contain an invalid preference from an older session.
  }
  let shownRuns = [];
  let hiddenRunsSaved = true;
  const clearRunsButton = document.getElementById('clear-runs');
  const restoreRunsButton = document.getElementById('restore-runs');
  clearRunsButton.addEventListener('click', () => hideRuns(shownRuns.map((run) => run.runId)));
  restoreRunsButton.addEventListener('click', () => {
    hiddenRuns.clear();
    saveHiddenRuns();
    refresh();
  });

  function saveHiddenRuns() {
    try {
      localStorage.setItem(HIDDEN_RUNS_KEY, JSON.stringify([...hiddenRuns]));
      hiddenRunsSaved = true;
    } catch {
      hiddenRunsSaved = false;
    }
    renderRunList(knownRuns);
  }

  function hideRuns(runIds) {
    for (const id of runIds) hiddenRuns.add(id);
    if (hiddenRuns.has(view.runId)) {
      ++selection;
      closeStream();
      view.runId = null;
      view.state = null;
      view.records = [];
      view.workers.clear();
      refs = null;
      setStrategy(null);
      clear(detailEl);
      detailEl.appendChild(el('p', 'empty', 'Select a run to view its details.'));
      clear(tickerEl);
      statusEl.textContent = elapsedEl.textContent = costTextEl.textContent = '—';
      costFillEl.style.transform = 'scaleX(0)';
    }
    saveHiddenRuns();
    refresh();
  }

  const runSearch = document.getElementById('run-search');
  runSearch.addEventListener('input', () => renderRunList(knownRuns));
  for (const button of document.querySelectorAll('[data-filter]')) {
    button.addEventListener('click', () => {
      runFilter = button.dataset.filter;
      for (const sibling of document.querySelectorAll('[data-filter]')) {
        sibling.setAttribute('aria-pressed', String(sibling === button));
      }
      renderRunList(knownRuns);
    });
  }

  function renderRunList(runs) {
    knownRuns = runs;
    const query = runSearch.value.trim().toLowerCase();
    runs = runs.filter((run) => {
      const matchesQuery = `${run.goal} ${run.strategy} ${run.runId}`.toLowerCase().includes(query);
      const matchesFilter = runFilter === 'all' ||
        (runFilter === 'active' && !TERMINAL.has(run.status)) ||
        (runFilter === 'attention' && (run.pendingApprovals > 0 || ['awaiting_acceptance', 'paused_human', 'paused_budget', 'interrupted'].includes(run.status)));
      return !hiddenRuns.has(run.runId) && matchesQuery && matchesFilter;
    });
    shownRuns = runs;
    clearRunsButton.disabled = runs.length === 0;
    restoreRunsButton.hidden = hiddenRuns.size === 0;
    document.getElementById('hidden-runs-note').textContent = hiddenRuns.size
      ? `${hiddenRuns.size} hidden in this browser. Records kept.${hiddenRunsSaved ? '' : ' Could not save this preference; it may reset on reload.'}`
      : '';
    document.getElementById('run-count').textContent = `${runs.length} / ${knownRuns.length}`;
    clear(runListEl);
    if (runs.length === 0) {
      const emptyMessage = knownRuns.length > 0 && knownRuns.every((run) => hiddenRuns.has(run.runId))
        ? 'All runs are hidden. Use Restore hidden to show them again.'
        : knownRuns.length ? 'No matching runs. Try another search or filter.' : 'No runs on record. Start a swarm to see its progress here.';
      runListEl.appendChild(el('li', 'empty', emptyMessage));
      return;
    }

    for (const run of runs) {
      const item = document.createElement('li');
      const card = el('button', `run-card ${run.strategy}`);
      card.type = 'button';
      card.setAttribute('aria-current', String(run.runId === view.runId));

      card.appendChild(el('div', 'run-flag', run.strategy));
      card.appendChild(el('div', 'goal', run.goal.split('\n')[0]));
      const meta = el('div', 'meta');
      meta.appendChild(el('span', `status ${run.status}`, words(run.status)));
      meta.appendChild(el('span', null, ` ${run.strategy} · ${run.taskCount} tasks · ${money(run.costUsd)}`));
      card.appendChild(meta);

      card.addEventListener('click', () => selectRun(run.runId));
      item.appendChild(card);
      const hideButton = el('button', 'hide-run', 'Hide');
      hideButton.type = 'button';
      hideButton.setAttribute('aria-label', `Hide run ${run.runId}`);
      hideButton.addEventListener('click', () => hideRuns([run.runId]));
      item.appendChild(hideButton);
      runListEl.appendChild(item);
    }
  }

  // -------------------------------------------------------------- run detail

  function mountDetail(strategy) {
    clear(detailEl);
    const frag = template.content.cloneNode(true);
    const labels = DASHBOARD_LABELS;
    const approvalsHeading = frag.querySelector('[data-heading="approvals"]');
    const orderPaperHeading = frag.querySelector('[data-heading="orderPaper"]');
    if (approvalsHeading) approvalsHeading.textContent = labels.approvalsHeading;
    if (orderPaperHeading) orderPaperHeading.textContent = labels.orderPaperHeading;
    refs = {
      goal: frag.querySelector('[data-goal]'),
      headlineMeta: frag.querySelector('[data-headline-meta]'),
      lastError: frag.querySelector('[data-last-error]'),
      approvals: frag.querySelector('[data-approvals]'),
      approvalList: frag.querySelector('[data-approval-list]'),
      workers: frag.querySelector('[data-workers]'),
      floor: frag.querySelector('[data-floor]'),
      statement: frag.querySelector('[data-statement]'),
      statementTitle: frag.querySelector('[data-statement-title]'),
      statementBody: frag.querySelector('[data-statement-body]'),
      tasks: frag.querySelector('[data-tasks]'),
      ledger: frag.querySelector('[data-ledger]'),
      ledgerCount: frag.querySelector('[data-ledger-count]'),
      ledgerToggle: frag.querySelector('[data-ledger-toggle]'),
      // Carried alongside the other refs so renderTasks() reads the same resolved set mountDetail
      // just applied to the headings, rather than re-resolving the strategy and risking the two
      // drifting apart.
      labels,
    };
    refs.ledgerToggle.addEventListener('click', () => {
      view.raw = !view.raw;
      refs.ledgerToggle.textContent = view.raw ? 'Plain English' : 'Raw JSON';
      renderLedger();
    });
    detailEl.appendChild(frag);
    for (const button of detailEl.querySelectorAll('[data-section]')) {
      button.addEventListener('click', () => {
        const section = button.dataset.section;
        detailEl.dataset.section = section;
        for (const sibling of detailEl.querySelectorAll('[data-section]')) {
          sibling.setAttribute('aria-pressed', String(sibling === button));
        }
      });
    }
    detailEl.dataset.section = 'overview';
  }

  function renderHeadline() {
    const state = view.state;
    refs.goal.textContent = state.task.goal.split('\n')[0];
    clear(refs.headlineMeta);
    refs.headlineMeta.appendChild(
      el('span', null, `${state.strategy} · ${state.workerCalls} worker calls · ${state.runId}`),
    );
    const nodes = Object.values(state.graph?.nodes || {});
    const settled = nodes.filter((node) => node.phase === 'settled').length;
    const progress = detailEl.querySelector('[data-run-progress]');
    clear(progress);
    progress.appendChild(el('span', null, `${settled} / ${nodes.length} tasks settled`));
    const meter = document.createElement('progress');
    meter.max = Math.max(1, nodes.length);
    meter.value = settled;
    meter.setAttribute('aria-label', 'Tasks settled');
    const track = el('span', 'task-progress-track');
    track.classList.toggle('is-active', ['running', 'remediation'].includes(state.status));
    track.appendChild(meter);
    progress.appendChild(track);
    const active = nodes.filter((node) => node.phase === 'running').length;
    const blocked = nodes.filter((node) => node.phase === 'blocked').length;
    progress.appendChild(el('span', null, `${active} running · ${blocked} blocked`));
    refs.lastError.hidden = !state.lastError;
    if (state.lastError) refs.lastError.textContent = state.lastError;
    renderOverview();
  }

  function renderOverview() {
    const state = view.state;
    const nodes = Object.values(state.graph?.nodes || {});
    const outcomes = {
      completed: 'Delivery accepted after independent review.',
      awaiting_acceptance: 'The swarm submitted its delivery. Independent review is still required.',
      paused_budget: 'Paused at a resource limit. A decision is required to continue.',
      paused_human: 'Paused while awaiting a human decision.',
      interrupted: 'Execution was interrupted. The run can be resumed.',
      failed: 'The run failed. Review the error and event log for details.',
      stopped: 'The run was stopped before completion.',
      terminated_incomplete: 'The run ended without an accepted delivery.',
      remediation: 'The swarm is addressing review findings.',
      running: nodes.length ? 'The swarm is implementing and reviewing the work.' : 'The swarm is inspecting the repository and preparing its plan.',
    };
    detailEl.querySelector('[data-overview-outcome]').textContent = outcomes[state.status] || words(state.status);
    const metrics = detailEl.querySelector('[data-overview-metrics]');
    clear(metrics);
    const approved = nodes.filter((node) => taskDisplayStatus(node) === 'approved').length;
    const pending = (state.pendingApprovals || []).filter((approval) => !approval.resolvedAt).length;
    for (const [label, value] of [
      ['Status', words(state.status)],
      ['Tasks approved', `${approved} / ${nodes.length}`],
      ['Spend / budget', `$${Number(state.costUsd || 0).toFixed(4)} / $${Number(state.budgetUsd || 0).toFixed(2)}`],
      ['Worker calls', String(state.workerCalls || 0)],
      ['Pending decisions', String(pending)],
      ['Last updated', new Date(state.updatedAt || state.createdAt).toLocaleString()],
    ]) {
      const item = el('div');
      item.append(el('dt', null, label), el('dd', null, value));
      metrics.appendChild(item);
    }
  }

  function renderApprovals() {
    const open = (view.state.pendingApprovals || []).filter((a) => !a.resolvedAt);
    refs.approvals.hidden = open.length === 0 && !['awaiting_acceptance', 'interrupted', 'paused_budget', 'paused_human'].includes(view.state.status);
    clear(refs.approvalList);

    const status = view.state.status;
    let guidance = '';
    let command = '';
    if (status === 'awaiting_acceptance') {
      guidance = 'The swarm has submitted its delivery. Independent review is required before the run is accepted. Run this command in Claude Code to review the evidence and accept or return the work.';
      command = '/swarm-accept ' + view.state.runId;
    } else if (status === 'interrupted') {
      guidance = 'Execution was interrupted. Resume continues this run from its saved state under the same doctrine.';
      command = '/swarm-resume ' + view.state.runId;
    } else if (open.length === 0 && (status === 'paused_budget' || status === 'paused_human')) {
      guidance = 'This run is paused. Inspect its status to identify the decision needed before it can continue.';
      command = '/swarm-status ' + view.state.runId;
    }
    if (guidance) {
      const item = el('li', 'attention-guidance');
      item.appendChild(el('p', null, guidance));
      item.appendChild(el('code', 'attention-command', command));
      refs.approvalList.appendChild(item);
    }
    if (open.length) refs.approvalList.appendChild(el('li', 'meta', 'Resolve these approvals in Claude Code. Choose approve, reject or modify there; this dashboard does not submit decisions.'));

    for (const approval of open) {
      const li = document.createElement('li');
      li.appendChild(el('span', 'status blocked_on_human', words(approval.kind)));
      li.appendChild(el('span', null, approval.description));

      const command = '/swarm-decide ' + view.state.runId + ' ' + approval.id;
      li.appendChild(el('code', 'attention-command', command));
      const copy = el('button', 'toggle', 'Copy decision command');
      copy.type = 'button';
      copy.addEventListener('click', async () => {
        try {
          await navigator.clipboard.writeText(command);
          copy.textContent = 'Copied';
          setTimeout(() => (copy.textContent = 'Copy decision command'), 1500);
        } catch {
          copy.textContent = 'Select the command above to copy';
        }
      });
      li.appendChild(copy);
      refs.approvalList.appendChild(li);
    }
  }

  function renderTasks() {
    const graph = view.state.graph;
    const labels = refs.labels || DASHBOARD_LABELS;
    const expanded = new Set([...refs.tasks.querySelectorAll('details[open]')].map((item) => item.dataset.taskId));
    clear(refs.tasks);

    const order = graph && graph.order ? graph.order : graph ? Object.keys(graph.nodes) : [];
    if (order.length === 0) {
      refs.tasks.appendChild(el('li', 'empty', labels.noPlan));
      return;
    }

    for (const id of order) {
      const node = graph.nodes[id];
      if (!node) continue;
      const depCount = node.dependsOn ? node.dependsOn.length : 0;
      const li = document.createElement('li');
      li.style.paddingLeft = `${Math.min(depCount, 4) * 1.1}rem`;
      // The indent depth is real structure — how many other work items this one waits on — not
      // decoration, so it needs to say so: unexplained, a staggered list reads as misaligned.
      const unit = depCount === 1 ? labels.dependencyUnit : `${labels.dependencyUnit}s`;
      const depLabel = depCount === 0 ? 'No dependencies' : `Depends on ${depCount} other ${unit}`;
      li.title = depLabel;
      li.setAttribute('aria-label', `${depLabel}. ${node.title}`);
      if (depCount > 0) li.classList.add('has-deps');
      const taskStatus = taskDisplayStatus(node);
      const details = el('details', 'task-detail');
      details.dataset.taskId = id;
      details.open = expanded.has(id);
      const summary = document.createElement('summary');
      summary.appendChild(el('span', `status ${taskStatus}`, words(taskStatus)));
      summary.appendChild(el('span', null, node.title));
      details.appendChild(summary);
      const body = el('div', 'task-evidence');
      if (node.description) body.appendChild(el('p', null, node.description));
      if (depCount > 0) {
        body.appendChild(el('p', 'meta', `Depends on: ${node.dependsOn.map((dependency) => graph.nodes[dependency]?.title || dependency).join(', ')}`));
      }
      if (node.acceptanceCriteria?.length) {
        body.appendChild(el('h3', null, 'Acceptance criteria'));
        const criteria = document.createElement('ul');
        for (const criterion of node.acceptanceCriteria) criteria.appendChild(el('li', null, criterion));
        body.appendChild(criteria);
      }
      for (const attempt of node.attempts || []) {
        body.appendChild(el('p', null, `Attempt ${attempt.attempt}: ${words(attempt.outcome)}${attempt.rationale ? ' — ' + attempt.rationale : ''}`));
      }
      if (!body.childElementCount) body.appendChild(el('p', 'empty', 'No further task details recorded yet.'));
      details.appendChild(body);
      li.appendChild(details);
      refs.tasks.appendChild(li);
    }
  }

  function taskDisplayStatus(node) {
    const latestOutcome = node.attempts && node.attempts.length
      ? node.attempts[node.attempts.length - 1].outcome
      : undefined;
    if (node.phase === 'running') return 'in_progress';
    if (node.phase === 'blocked') return 'blocked_on_human';
    if (node.phase === 'settled') return latestOutcome || 'settled';
    if (node.phase === 'abandoned') return latestOutcome || 'abandoned';
    return 'queued';
  }

  function renderWorkers() {
    clear(refs.workers);
    if (view.workers.size === 0) {
      refs.workers.appendChild(el('p', 'empty', 'No worker has been called yet.'));
      return;
    }

    const now = Date.now();
    for (const worker of [...view.workers.values()].sort((a, b) => b.lastSeen - a.lastSeen)) {
      const card = el('article', 'worker-card');
      if (now - worker.lastSeen > IDLE_MS) card.classList.add('idle');
      card.appendChild(el('div', 'worker-name', worker.id));
      card.appendChild(el('div', 'worker-model', worker.model));
      card.appendChild(el('div', 'worker-last', `${words(worker.role || 'worker')} · last call ${clockTime(worker.lastSeen)}`));
      const stats = el('div', 'worker-stats');
      stats.appendChild(el('span', null, `${worker.calls} calls`));
      stats.appendChild(el('span', null, `${worker.promptTokens + worker.completionTokens} tok`));
      stats.appendChild(el('span', null, money(worker.costUsd)));
      card.appendChild(stats);
      refs.workers.appendChild(card);
    }
  }

  function renderLedger() {
    clear(refs.ledger);
    // Only real ledger lines are counted; the closing statement is rhetoric, not a record.
    const entries = view.records.filter((r) => !r.synthetic);
    refs.ledgerCount.textContent = `${entries.length} entries`;

    if (entries.length === 0) {
      refs.ledger.appendChild(el('p', 'empty', 'Nothing recorded.'));
      return;
    }

    const table = document.createElement('table');
    const tbody = document.createElement('tbody');
    // Newest first: during a live run the tail is what matters.
    for (const record of [...entries].reverse()) {
      const tr = document.createElement('tr');
      tr.appendChild(el('td', 'ts', clockTime(record.entry.ts)));
      tr.appendChild(el('td', 'type', record.entry.type));
      const dataCell = el('td', 'data');
      if (view.raw) {
        dataCell.textContent = JSON.stringify(record.entry.data);
      } else if (record.line && record.line.text) {
        dataCell.textContent = record.line.text;
      } else {
        // The narrator deliberately keeps some event types (see DoctrineNarrator's SILENT set)
        // off the doctrine ticker — bookkeeping, not politics — so these rows have no narrated
        // line. Showing the raw payload inline reads as noise next to a table of hand-narrated
        // sentences, so it's collapsed instead: scannable by default, still available on demand.
        dataCell.appendChild(rawFallback(record.entry));
      }
      tr.appendChild(dataCell);
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    refs.ledger.appendChild(table);
  }

  /** A collapsed raw-payload aside for a ledger entry the narrator has nothing to say about. */
  function rawFallback(entry) {
    const details = el('details', 'ledger-raw');
    details.appendChild(el('summary', null, words(entry.type)));
    details.appendChild(el('pre', null, JSON.stringify(entry.data, null, 2)));
    return details;
  }

  // ------------------------------------------------------------- live stream

  function noteWorkerCall(entry) {
    const d = entry.data || {};
    const id = d.personaId || d.role || 'unknown';
    const worker = view.workers.get(id) || {
      id,
      model: d.model,
      calls: 0,
      promptTokens: 0,
      completionTokens: 0,
      costUsd: 0,
      lastSeen: 0,
    };
    worker.model = d.model || worker.model;
    worker.role = d.role || worker.role;
    worker.calls += 1;
    worker.promptTokens += Number(d.promptTokens || 0);
    worker.completionTokens += Number(d.completionTokens || 0);
    worker.costUsd += Number(d.costUsd || 0);
    worker.lastSeen = new Date(entry.ts).getTime() || Date.now();
    view.workers.set(id, worker);
  }

  function ingestLedger(entry, line) {
    const record = { entry, line: line || null };
    view.records.push(record);
    pushTicker(record);
    if (entry.type === 'worker_call') {
      noteWorkerCall(entry);
      renderWorkers();
    }
    renderLedger();
  }

  function renderStatement() {
    if (!refs) return;
    const s = view.statement;
    refs.statement.hidden = !s;
    refs.floor.hidden = false;
    if (!s) return;

    refs.statementTitle.textContent = s.title;
    clear(refs.statementBody);
    for (const paragraph of s.paragraphs) refs.statementBody.appendChild(el('p', null, paragraph));
  }

  function ingestState(state, statement) {
    const wasTerminal = view.state ? TERMINAL.has(view.state.status) : false;
    view.state = state;
    if (statement) view.statement = statement;

    setStrategy(state.strategy);
    renderHeader();
    renderHeadline();
    renderApprovals();
    renderTasks();
    renderStatement();

    // Announce the close once, so the ticker ends on the doctrine rather than on whatever
    // housekeeping event happened to come last. Recorded in `records` as well as pushed, so a
    // later re-render keeps it.
    if (!view.closingAnnounced && TERMINAL.has(state.status) && view.statement) {
      view.closingAnnounced = true;
      const record = {
        entry: { ts: state.updatedAt, type: 'statement', data: {} },
        line: { text: view.statement.closing, tone: 'ruling' },
        // Belongs in the ticker, not the ledger — nothing was written to ledger.jsonl for it.
        synthetic: true,
      };
      view.records.push(record);
      if (wasTerminal === false) pushTicker(record);
    }
  }

  function openStream(runId) {
    closeStream();
    stream = new EventSource(`/api/stream?runId=${encodeURIComponent(runId)}`);
    setConnection('connecting');

    stream.addEventListener('open', () => setConnection('live'));
    stream.addEventListener('error', () => setConnection('reconnecting'));

    stream.addEventListener('ledger', (ev) => {
      setConnection('live');
      const payload = JSON.parse(ev.data);
      if (gallery.active) {
        pushGalleryLine(payload.runId, payload.line);
        return;
      }
      if (payload.runId !== view.runId) return;
      ingestLedger(payload.entry, payload.line);
    });

    // Only sent when SWARM_DASHBOARD_RHETORIC=llm, and always after the deterministic statement
    // has already been shown — this replaces prose rather than waiting for it.
    stream.addEventListener('statement', (ev) => {
      const payload = JSON.parse(ev.data);
      if (gallery.active || payload.runId !== view.runId) return;
      view.statement = payload.statement;
      renderStatement();
      // The run was already over; this was the last frame owed, so the stream can go now.
      if (statementTimer !== null) closeStream();
    });

    stream.addEventListener('state', (ev) => {
      setConnection('live');
      const payload = JSON.parse(ev.data);
      if (gallery.active) {
        // Reuse the summary shape the gallery renders from.
        const s = payload.state;
        if (hiddenRuns.has(s.runId) || !gallery.panels.has(s.runId)) return;
        updateGalleryPanel({
          runId: s.runId,
          strategy: s.strategy,
          status: s.status,
          goal: s.task.goal,
          costUsd: s.costUsd,
          budgetUsd: s.budgetUsd,
          workerCalls: s.workerCalls,
          taskCount: s.graph ? Object.keys(s.graph.nodes).length : 0,
          createdAt: s.createdAt,
        });
        if (payload.statement) pushGalleryLine(s.runId, { text: payload.statement.closing, tone: 'ruling' });
        return;
      }
      if (payload.runId !== view.runId) return;
      ingestState(payload.state, payload.statement);
      if (!TERMINAL.has(payload.state.status)) return;

      // Closing here unconditionally would drop the re-voiced closing statement every time: it
      // is composed by a model after this frame, so the connection carrying it would already be
      // gone. When the server says one is coming, wait for it.
      if (payload.revoicing) {
        clearTimeout(statementTimer);
        statementTimer = setTimeout(closeStream, STATEMENT_WAIT_MS);
      } else {
        closeStream();
      }
    });
  }

  function closeStream() {
    if (statementTimer !== null) {
      clearTimeout(statementTimer);
      statementTimer = null;
    }
    if (stream) {
      stream.close();
      stream = null;
    }
    setConnection('idle');
  }

  window.addEventListener('beforeunload', closeStream);

  // --------------------------------------------------------------- selection

  /**
   * Guards against two selections being in flight at once — a second click, or the ten-second
   * poll's auto-select landing on top of one. Both await the same endpoint, so without this the
   * slower response wins the render and leaves the page showing one run's record under another
   * run's id, subscribed to a third.
   */
  let selection = 0;

  async function selectRun(runId) {
    const generation = ++selection;
    closeStream();
    refs = null;
    view.state = null;
    renderHeader();
    view.runId = runId;
    renderRunList(knownRuns);
    view.workers = new Map();
    view.records = [];
    view.statement = null;
    view.closingAnnounced = false;

    clear(detailEl);
    detailEl.appendChild(el('p', 'empty', 'Loading run details…'));

    try {
      // Replay first, then subscribe. Anything recorded in the gap arrives on the stream and is
      // appended; the ledger is append-only, so the two cannot disagree about the past.
      const { state, ledger, ticker, statement } = await getJson(`/api/run/${encodeURIComponent(runId)}`);
      if (generation !== selection) return; // superseded while the record was loading
      mountDetail(state.strategy);

      ledger.forEach((entry, i) => {
        view.records.push({ entry, line: (ticker && ticker[i]) || null });
        if (entry.type === 'worker_call') noteWorkerCall(entry);
      });

      view.statement = statement || null;
      ingestState(state, statement);
      renderWorkers();
      renderLedger();
      renderTicker();

      if (TERMINAL.has(state.status)) closeStream();
      else openStream(runId);
    } catch (err) {
      if (generation === selection) {
        setConnection('error');
        showError(detailEl, err);
      }
    }
  }

  async function refresh() {
    try {
      const { runs } = await getJson('/api/runs');
      renderRunList(runs);
      const visibleRuns = runs.filter((run) => !hiddenRuns.has(run.runId));
      if (view.runId === null && visibleRuns.length > 0) {
        // Prefer a live run if there is one — that is what the page is for.
        const live = visibleRuns.find((r) => !TERMINAL.has(r.status));
        await selectRun((live || visibleRuns[0]).runId);
      } else if (view.runId === null) {
        closeStream();
      }
    } catch (err) {
      setConnection('error');
      showError(runListEl, err);
    }
  }

  // Idle-dimming is time-based, so repaint the floor even when nothing arrives.
  setInterval(() => {
    if (refs && view.workers.size > 0) renderWorkers();
  }, 5000);

  // The stream carries events, not the run list; a newly started run appears only on a poll.
  setInterval(() => (gallery.active ? renderGallery() : refresh()), 10_000);

  loadEpigraphs();
  newsreel.load();

  // ?gallery in the URL opens straight into the tiled view — handy for a benchmark race.
  if (new URLSearchParams(location.search).has('gallery')) setView(true);
  else refresh();
})();
