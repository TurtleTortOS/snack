/* SNACK app logic.
 * Runs in two modes:
 *  - demo mode:  opened directly in a browser (file:// or any static server).
 *                All state is in-memory; the UI is fully interactive so the
 *                design can be reviewed without the Tauri shell.
 *  - Tauri mode: running inside the desktop shell. Calls go to Rust commands
 *                via window.__TAURI__.core.invoke(...).
 */

const TAURI = (typeof window !== 'undefined' && window.__TAURI__ && window.__TAURI__.core) ? window.__TAURI__.core : null;
const IN_TAURI = !!TAURI;

// ---------- static catalog (bundled; mirrors catalog.json) ----------
const CATALOG = [
  {
    id: 'qualcomm/Qwen3.8-4B',
    name: 'Qwen3.8-4B',
    tag: 'FAST',
    usecase: 'Quick questions, short answers, lowest latency.',
    sizeGB: 2.43,
    tps: 10.2,
    coldLoadS: 15,
    installed: true,
  },
  {
    id: 'qualcomm/Qwen3.8-9B',
    name: 'Qwen3.8-9B',
    tag: 'SMART',
    usecase: 'Longer answers, better reasoning, longer context.',
    sizeGB: 5.08,
    tps: 7.1,
    coldLoadS: 30,
    installed: true,
  },
];

const CTX_STEPS = [8192, 16384, 32768, 65536];

// ---------- state ----------
const state = {
  serverOn: false,
  serverState: 'stopped',   // stopped | warming | running
  selected: 'qualcomm/Qwen3.8-9B',
  ctx: { 'qualcomm/Qwen3.8-4B': 65536, 'qualcomm/Qwen3.8-9B': 65536 },
  doctor: [],
};

function fmtCtx(n) { return (n / 1024) + 'k'; }

// ---------- Tauri invoke helper (falls back to demo behavior) ----------
async function invoke(cmd, args) {
  if (IN_TAURI) return await TAURI.invoke(cmd, args);
  return demoInvoke(cmd, args);
}

// Demo-mode stand-ins (no real processes in the browser).
function demoInvoke(cmd, args) {
  return new Promise((resolve) => {
    setTimeout(() => {
      switch (cmd) {
        case 'server_toggle':
          state.serverOn = args.on;
          state.serverState = args.on ? 'warming' : 'stopped';
          if (args.on) setTimeout(() => { state.serverState = 'running'; renderStatus(); }, 2500);
          return resolve({ state: state.serverState });
        case 'server_status':
          return resolve({ state: state.serverState, model: state.selected, nctx: state.ctx[state.selected] });
        case 'model_select':
          state.selected = args.id;
          return resolve({ warming: true });
        case 'model_context':
          state.ctx[args.id] = args.nctx;
          return resolve({ ok: true });
        case 'config_get': {
          const c = { model: state.selected, nctx: state.ctx[state.selected], port: 18181 };
          return resolve(c);
        }
        case 'doctor_run':
          return resolve([
            { name: 'NPU present', pass: true },
            { name: 'GenieX runtime intact', pass: true },
            { name: 'Model files (SHA256)', pass: true },
            { name: 'Model manager IDs registered', pass: true },
            { name: 'Server on port 18181', pass: state.serverOn },
            { name: 'Inference smoke test', pass: state.serverOn },
            { name: 'Hermes reachable', pass: true },
          ]);
        case 'models_reregister':
          return resolve({ ok: true });
        case 'chat_launch':
          return resolve({ launched: true });
        default:
          return resolve(null);
      }
    }, 120);
  });
}

// ---------- rendering ----------
function renderStatus() {
  const dot = document.getElementById('statusDot');
  const txt = document.getElementById('statusText');
  const label = document.getElementById('toggleLabel');
  const toggle = document.getElementById('serverToggle');
  const homeState = document.getElementById('homeState');

  dot.className = 'status-dot ' + (state.serverState === 'running' ? 'running' : state.serverState === 'warming' ? 'warming' : '');
  txt.textContent = state.serverState;
  homeState.textContent = state.serverState;
  toggle.setAttribute('aria-pressed', String(state.serverOn));
  label.textContent = state.serverOn ? 'On' : 'Off';

  const sel = CATALOG.find((m) => m.id === state.selected);
  if (sel) {
    document.getElementById('homeModel').textContent = sel.name;
    document.getElementById('quickTps').textContent = '~' + sel.tps;
    document.getElementById('quickSize').textContent = sel.sizeGB.toFixed(2) + ' GB';
  }
  document.getElementById('homeCtx').textContent = fmtCtx(state.ctx[state.selected]);
  renderModels();
}

function renderModels() {
  const list = document.getElementById('modelList');
  list.innerHTML = '';
  for (const m of CATALOG) {
    const isSel = m.id === state.selected;
    const ctx = state.ctx[m.id];
    const card = document.createElement('div');
    card.className = 'model-card' + (isSel ? ' selected' : '') + (m.installed ? '' : ' disabled');

    const main = document.createElement('div');
    main.className = 'model-main';
    main.innerHTML =
      `<div class="model-name">${m.name}<span class="model-tag">${m.tag}</span>${isSel ? '<span class="selected-badge">● ACTIVE</span>' : ''}</div>` +
      `<div class="model-usecase">${m.usecase}</div>` +
      `<div class="model-specs">` +
      `<span class="model-spec"><b>${m.sizeGB.toFixed(2)}</b> GB</span>` +
      `<span class="model-spec"><b>~${m.tps}</b> tok/s</span>` +
      `<span class="model-spec">cold load <b>~${m.coldLoadS}s</b></span>` +
      (m.installed ? '' : `<span class="model-spec" style="color:var(--warn)">not installed</span>`) +
      `</div>`;

    const actions = document.createElement('div');
    actions.className = 'model-actions';
    if (m.installed) {
      actions.innerHTML =
        (isSel ? `<div class="selected-badge">running default</div>` : `<button class="btn small primary" data-select="${m.id}">Select</button>`) +
        `<div class="ctx-stepper">` +
        `<button data-ctx-minus="${m.id}">−</button>` +
        `<span class="ctx-val" id="ctx-${cssSafe(m.id)}">${fmtCtx(ctx)}</span>` +
        `<button data-ctx-plus="${m.id}">+</button>` +
        `</div>`;
    } else {
      actions.innerHTML = `<button class="btn small" disabled>Install</button>`;
    }
    card.appendChild(main);
    card.appendChild(actions);
    list.appendChild(card);
  }
}

function cssSafe(id) { return id.replace(/[^a-z0-9]/gi, '_'); }

function renderDoctor() {
  const box = document.getElementById('doctorResults');
  box.innerHTML = '';
  for (const d of state.doctor) {
    const row = document.createElement('div');
    row.className = 'doc-row ' + (d.pass ? 'pass' : 'fail');
    row.innerHTML =
      `<span class="doc-icon ${d.pass ? 'pass' : 'fail'}">${d.pass ? '✓' : '✗'}</span>` +
      `<span class="doc-name">${d.name}</span>` +
      `<span class="doc-fix">${d.pass ? '' : (d.fix || 'see log')}</span>`;
    box.appendChild(row);
  }
}

async function renderConfig() {
  const c = await invoke('config_get');
  document.getElementById('configPre').textContent = JSON.stringify(c, null, 2);
}

// ---------- actions ----------
async function toggleServer() {
  const on = !state.serverOn;
  const res = await invoke('server_toggle', { on });
  state.serverOn = on;
  state.serverState = res && res.state ? res.state : (on ? 'warming' : 'stopped');
  renderStatus();
}

async function selectModel(id) {
  const res = await invoke('model_select', { id });
  state.selected = id;
  if (res && res.warming) state.serverState = state.serverOn ? 'warming' : 'stopped';
  renderStatus();
}

async function stepCtx(id, dir) {
  const cur = state.ctx[id];
  let i = CTX_STEPS.indexOf(cur);
  i = Math.max(0, Math.min(CTX_STEPS.length - 1, i + dir));
  const n = CTX_STEPS[i];
  await invoke('model_context', { id, nctx: n });
  state.ctx[id] = n;
  renderStatus();
  if (id === state.selected) renderConfig();
}

async function runDoctor() {
  const btn = document.getElementById('runDoctor');
  btn.disabled = true;
  btn.textContent = 'Running…';
  const results = await invoke('doctor_run');
  state.doctor = results;
  renderDoctor();
  btn.disabled = false;
  btn.textContent = 'Run Doctor';
}

async function reRegister() {
  await invoke('models_reregister');
}

async function launchChat() {
  if (IN_TAURI) {
    await invoke('chat_launch');
  } else {
    alert('In the desktop app this opens Hermes, pointed at the selected model (' +
      CATALOG.find((m) => m.id === state.selected).name + ').');
  }
}

async function copyText(text) {
  try { await navigator.clipboard.writeText(text); } catch (e) { /* ignore */ }
  const el = event && event.currentTarget;
  if (el) { const t = el.textContent; el.textContent = 'Copied'; setTimeout(() => { el.textContent = t; }, 1000); }
}

// ---------- wiring ----------
document.addEventListener('DOMContentLoaded', () => {
  // tabs
  document.querySelectorAll('.tab').forEach((t) => {
    t.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach((x) => x.classList.remove('active'));
      document.querySelectorAll('.panel').forEach((p) => p.classList.remove('active'));
      t.classList.add('active');
      document.getElementById('panel-' + t.dataset.panel).classList.add('active');
    });
  });

  // mode tag
  document.getElementById('modeTag').textContent = IN_TAURI ? 'desktop' : 'demo mode';

  // server toggle
  document.getElementById('serverToggle').addEventListener('click', toggleServer);
  document.getElementById('launchChat').addEventListener('click', launchChat);
  document.getElementById('runDoctor').addEventListener('click', runDoctor);
  document.getElementById('reRegister').addEventListener('click', reRegister);

  // copy buttons
  document.querySelectorAll('[data-copy]').forEach((b) => {
    b.addEventListener('click', () => copyText(document.getElementById(b.dataset.copy).textContent));
  });
  document.querySelectorAll('[data-copy-text]').forEach((b) => {
    b.addEventListener('click', () => copyText(b.dataset.copyText));
  });

  // delegated model-card actions
  document.getElementById('modelList').addEventListener('click', (e) => {
    const sel = e.target.closest('[data-select]');
    if (sel) { selectModel(sel.dataset.select); return; }
    const plus = e.target.closest('[data-ctx-plus]');
    if (plus) { stepCtx(plus.dataset.ctxPlus, +1); return; }
    const minus = e.target.closest('[data-ctx-minus]');
    if (minus) { stepCtx(minus.dataset.ctxMinus, -1); return; }
  });

  // initial paint
  renderStatus();
  renderConfig();

  // deep-link: #home | #models | #system | #about
  if (location.hash) {
    const target = document.querySelector('.tab[data-panel="' + location.hash.slice(1) + '"]');
    if (target) target.click();
  }

  // poll server status so "warming" -> "running" flips without user action
  setInterval(async () => {
    const s = await invoke('server_status');
    if (s && s.state !== state.serverState) {
      state.serverState = s.state;
      state.serverOn = s.state !== 'stopped';
      renderStatus();
    }
  }, 2000);
});
