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
    // transformer geometry, for the KV-cache estimate
    layers: 36, kvHeads: 8, headDim: 128,
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
    layers: 36, kvHeads: 8, headDim: 128,
  },
];

// context: 16k steps up to a 256k roof
const CTX_MIN = 16384;
const CTX_STEP = 16384;
const CTX_MAX = 262144;

// KV-cache quant options: value = bytes per element (K and V quantized independently)
const KV_TYPES = { 'F16': 2, 'Q8_0': 1, 'Q4_0': 0.5 };

// device memory; demo mode = Surface Pro 11. Tauri mode: backend supplies the real figure.
const DEVICE_MEM_GB = 16;

// ---------- state ----------
const state = {
  serverOn: false,
  serverState: 'stopped',   // stopped | warming | running
  selected: 'qualcomm/Qwen3.8-9B',
  ctx: { 'qualcomm/Qwen3.8-4B': 65536, 'qualcomm/Qwen3.8-9B': 65536 },
  kv: {
    'qualcomm/Qwen3.8-4B': { k: 'Q8_0', v: 'Q4_0' },
    'qualcomm/Qwen3.8-9B': { k: 'Q8_0', v: 'Q4_0' },
  },
  doctor: [],
};

function fmtCtx(n) { return (n / 1024) + 'k'; }

// KV-cache estimate (GB) for ONE tensor type: layers × kvHeads × headDim × ctx × bytes
function kvEstGB(m, ctx, bytes) {
  return (m.layers * m.kvHeads * m.headDim * ctx * bytes) / 1e9;
}

// total estimate: model file + KV(K) + KV(V)
function fitEstimate(m) {
  const ctx = state.ctx[m.id];
  const kv = state.kv[m.id];
  const kvGB = kvEstGB(m, ctx, KV_TYPES[kv.k]) + kvEstGB(m, ctx, KV_TYPES[kv.v]);
  return m.sizeGB + kvGB;
}

function fmtGB(gb) { return gb >= 100 ? Math.round(gb).toString() : gb.toFixed(1); }

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
          const c = {
            model: state.selected,
            nctx: state.ctx[state.selected],
            cacheTypeK: state.kv[state.selected].k,
            cacheTypeV: state.kv[state.selected].v,
            port: 18181,
          };
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

    const controls = document.createElement('div');
    controls.className = 'model-controls';
    if (m.installed) {
      const kv = state.kv[m.id];
      const fit = fitEstimate(m);
      const over = fit > DEVICE_MEM_GB;
      controls.innerHTML =
        `<div class="info-box ${over ? 'over' : ''}" title="${over ? 'Does not fit in device memory' : 'Fits in device memory'}">${over ? '!' : 'i'}</div>` +
        `<div class="model-actions">` +
        `<div class="stepper-row">` +
        `<div class="ctx-stepper">` +
        `<button data-ctx-minus="${m.id}" ${ctx <= CTX_MIN ? 'disabled' : ''}>−</button>` +
        `<span class="ctx-val" id="ctx-${cssSafe(m.id)}">${fmtCtx(ctx)}</span>` +
        `<button data-ctx-plus="${m.id}" ${ctx >= CTX_MAX ? 'disabled' : ''}>+</button>` +
        `</div>` +
        (isSel ? `<span class="selected-badge">running default</span>` : `<button class="btn small primary" data-select="${m.id}">Select</button>`) +
        `</div>` +
        `<div class="kv-row">` +
        `<span class="kv-pair">K <select data-kv-k="${m.id}">` +
        Object.keys(KV_TYPES).map((t) => `<option ${kv.k === t ? 'selected' : ''}>${t}</option>`).join('') +
        `</select></span>` +
        `<span class="kv-pair">V <select data-kv-v="${m.id}">` +
        Object.keys(KV_TYPES).map((t) => `<option ${kv.v === t ? 'selected' : ''}>${t}</option>`).join('') +
        `</select></span>` +
        `<span class="fit-val ${over ? 'over' : ''}">Fit: <b>${fmtGB(fit)}</b> / <b>${DEVICE_MEM_GB}</b> GB</span>` +
        `</div>` +
        `</div>`;
    } else {
      controls.innerHTML =
        `<div class="info-box" title="Not installed">i</div>` +
        `<div class="model-actions"><button class="btn small" disabled>Install</button></div>`;
    }
    card.appendChild(main);
    card.appendChild(controls);
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
  const n = Math.max(CTX_MIN, Math.min(CTX_MAX, cur + dir * CTX_STEP));
  if (n === cur) return;
  await invoke('model_context', { id, nctx: n });
  state.ctx[id] = n;
  renderStatus();
  if (id === state.selected) renderConfig();
}

async function setKVType(id, which, type) {
  state.kv[id][which] = type;
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

// ---------- theme ----------
function applyTheme(t) {
  document.documentElement.setAttribute('data-theme', t);
  try { localStorage.setItem('snack-theme', t); } catch (e) { /* ignore */ }
}

// ---------- wiring ----------
document.addEventListener('DOMContentLoaded', () => {
  // theme toggle (persisted; ?theme= override for screenshots; defaults to system preference)
  let saved = null;
  try { saved = localStorage.getItem('snack-theme'); } catch (e) { /* ignore */ }
  const qs = new URLSearchParams(location.search);
  const qTheme = qs.get('theme');
  const qCtx = qs.get('ctx');
  if (qCtx && +qCtx >= CTX_MIN && +qCtx <= CTX_MAX && (+qCtx % CTX_STEP) === 0) {
    for (const id of Object.keys(state.ctx)) state.ctx[id] = +qCtx;
  }
  const systemDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
  applyTheme(qTheme === 'dark' || qTheme === 'light' ? qTheme : (saved || (systemDark ? 'dark' : 'light')));
  document.getElementById('themeToggle').addEventListener('click', () => {
    const cur = document.documentElement.getAttribute('data-theme');
    applyTheme(cur === 'dark' ? 'light' : 'dark');
  });

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
  document.getElementById('modelList').addEventListener('change', (e) => {
    const kSel = e.target.closest('[data-kv-k]');
    if (kSel) { setKVType(kSel.dataset.kvK, 'k', kSel.value); return; }
    const vSel = e.target.closest('[data-kv-v]');
    if (vSel) { setKVType(vSel.dataset.kvV, 'v', vSel.value); return; }
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
