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
  measuredTps: null, // last decode rate reported by the server
  harness: 'hermes', // hermes | pi | dsh
  dl: {}, // model_id -> { status, progress }
};

const HARNESS_COPY = {
  hermes: "Talk to the model you've selected in Hermes, the chat harness bundled with SNACK.",
  pi: "Talk to the model you've selected in Pi, the minimal terminal harness — pre-pointed at the SNACK endpoint.",
  dsh: "Talk to the model you've selected in DeepSeek Harness, the web-UI agent — pre-pointed at the SNACK endpoint.",
};
const HARNESS_NAME = { hermes: 'Hermes', pi: 'Pi', dsh: 'DeepSeek Harness' };

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
        case 'server_status': {
          const s = { state: state.serverState, model: state.selected, nctx: state.ctx[state.selected] };
          if (state.serverState === 'running') {
            const sel = CATALOG.find((m) => m.id === state.selected);
            s.measuredTps = +(sel.tps * 0.94).toFixed(1); // demo: simulated server report
          }
          return resolve(s);
        }
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
            harness: state.harness,
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
            { name: HARNESS_NAME[state.harness] + ' harness installed', pass: true },
          ]);
        case 'models_reregister':
          return resolve({ ok: true });
        case 'chat_launch':
          return resolve({ launched: true });
        case 'harness_select':
          state.harness = args.harness;
          return resolve(args.harness);
        case 'model_download':
          state.dl[args.model_id] = { status: 'downloading', progress: 0 };
          return resolve({ modelId: args.model_id, status: 'downloading', progress: 0 });
        case 'model_download_progress': {
          const d = state.dl[args.model_id];
          if (!d) return resolve({ modelId: args.model_id, status: 'idle', progress: null });
          d.progress = Math.min(1, d.progress + 0.12);
          if (d.progress >= 1) { d.status = 'complete'; }
          return resolve({ modelId: args.model_id, status: d.status, progress: d.progress });
        }
        case 'check_for_updates':
          return resolve({
            currentVersion: '0.2.0', latestTag: 'v0.2.0', latestPublished: '—',
            hasUpdate: false, downloadUrl: null, releaseUrl: 'https://github.com/TurtleTortOS/snack/releases',
          });
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
  // measured decode rate, reported by the server (only while running)
  const measured = document.getElementById('quickTpsMeasured');
  if (measured) {
    if (state.serverState === 'running' && state.measuredTps != null) {
      measured.textContent = String(state.measuredTps);
      measured.parentElement.classList.remove('idle');
    } else {
      measured.textContent = '—';
      measured.parentElement.classList.add('idle');
    }
  }
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
        `<div class="info-box ${over ? 'over' : ''}" data-tip="${over
          ? 'Warning: at this context + KV quant the model does not fit in device memory. Starting the server may OOM — the OS can kill other apps or hang. Lower context or KV quant first.'
          : 'K/V quant is how the KV cache is compressed in memory. Q8_0 ≈ lossless, Q4_0 smallest, F16 lossless but largest. See the legend below.'}">${over ? '!' : '?'}</div>` +
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
      const d = state.dl[m.id];
      if (d && d.status === 'downloading') {
        const pct = Math.round((d.progress || 0) * 100);
        controls.innerHTML =
          `<div class="info-box" data-tip="Downloading from TurtleTortOS/snack-models on HuggingFace.">…</div>` +
          `<div class="model-actions"><span class="selected-badge">downloading ${pct}%</span></div>`;
      } else if (d && d.status === 'error') {
        controls.innerHTML =
          `<div class="info-box over" data-tip="${d.error || 'Download failed — try again.'}">!</div>` +
          `<div class="model-actions"><button class="btn small primary" data-download="${m.id}">Retry download</button></div>`;
      } else {
        controls.innerHTML =
          `<div class="info-box" data-tip="Not installed yet — downloads from HuggingFace (TurtleTortOS/snack-models).">?</div>` +
          `<div class="model-actions"><button class="btn small primary" data-download="${m.id}">Download</button></div>`;
      }
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
  // sync the harness picker + Chat copy from the persisted config
  if (c && c.harness && HARNESS_COPY[c.harness]) {
    state.harness = c.harness;
    const sel = document.getElementById('harnessSelect');
    if (sel) sel.value = c.harness;
    document.getElementById('launchCopy').textContent = HARNESS_COPY[c.harness];
  }
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
  await invoke('model_context', { id, nctx: n, cacheTypeK: state.kv[id].k, cacheTypeV: state.kv[id].v });
  state.ctx[id] = n;
  renderStatus();
  if (id === state.selected) renderConfig();
}

async function setKVType(id, which, type) {
  state.kv[id][which] = type;
  await invoke('model_context', { id, nctx: state.ctx[id], cacheTypeK: state.kv[id].k, cacheTypeV: state.kv[id].v });
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
    alert('In the desktop app this opens ' + HARNESS_NAME[state.harness] + ', pointed at the selected model (' +
      CATALOG.find((m) => m.id === state.selected).name + ').');
  }
}

async function selectHarness(h) {
  state.harness = h;
  document.getElementById('launchCopy').textContent = HARNESS_COPY[h];
  await invoke('harness_select', { harness: h });
}

async function startDownload(id) {
  state.dl[id] = { status: 'downloading', progress: 0 };
  await invoke('model_download', { model_id: id });
  renderModels();
  // self-rescheduling poll (no setInterval backlog)
  for (;;) {
    await new Promise((r) => setTimeout(r, 800));
    const s = await invoke('model_download_progress', { model_id: id });
    if (!s || s.status === 'downloading') {
      state.dl[id] = { status: 'downloading', progress: s && s.progress != null ? s.progress : 0 };
      renderModels();
      continue;
    }
    if (s.status === 'complete') {
      const m = CATALOG.find((x) => x.id === id);
      if (m) m.installed = true;
      delete state.dl[id];
      await invoke('models_reregister');
    } else {
      state.dl[id] = { status: 'error', progress: null, error: s.error || 'download failed' };
    }
    renderModels();
    break;
  }
}

async function checkUpdates() {
  const btn = document.getElementById('checkUpdates');
  const info = document.getElementById('updateInfo');
  btn.disabled = true;
  btn.textContent = 'Checking…';
  try {
    const u = await invoke('check_for_updates');
    if (!u) { info.textContent = 'Update check unavailable in demo mode.'; }
    else if (u.hasUpdate) {
      info.innerHTML = 'Update available: ' + u.latestTag + ' (published ' + (u.latestPublished || '').slice(0, 10) + ') — ' +
        (u.downloadUrl ? '<a href="' + u.downloadUrl + '">download SnackSetup.exe</a>' : '<a href="' + u.releaseUrl + '">open the release</a>');
    } else {
      info.textContent = 'Up to date — ' + (u.latestTag || u.currentVersion) + ' is the latest release.';
    }
  } catch (e) {
    info.textContent = 'Update check failed: ' + e;
  }
  btn.disabled = false;
  btn.textContent = 'Check for updates';
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
  document.getElementById('memGb').textContent = DEVICE_MEM_GB;

  // server toggle
  document.getElementById('serverToggle').addEventListener('click', toggleServer);
  document.getElementById('launchChat').addEventListener('click', launchChat);
  document.getElementById('runDoctor').addEventListener('click', runDoctor);
  document.getElementById('reRegister').addEventListener('click', reRegister);
  document.getElementById('checkUpdates').addEventListener('click', checkUpdates);

  // harness picker (Chat card)
  const harnessSel = document.getElementById('harnessSelect');
  harnessSel.addEventListener('change', () => selectHarness(harnessSel.value));

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
    const dl = e.target.closest('[data-download]');
    if (dl) { startDownload(dl.dataset.download); return; }
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

  // Self-rescheduling poll loops: the next tick waits for the previous one
  // to finish, so slow responses can never pile up an invoke backlog.
  async function pollLoop(fn, ms) {
    for (;;) {
      try {
        await fn();
      } catch (e) {
        /* transient - keep polling */
      }
      await new Promise((r) => setTimeout(r, ms));
    }
  }

  // poll server status so "warming" -> "running" flips without user action
  pollLoop(async () => {
    const s = await invoke('server_status');
    if (s) {
      if (s.state !== state.serverState) state.serverState = s.state;
      state.serverOn = s.state !== 'stopped';
      state.measuredTps = (s.measuredTps != null) ? s.measuredTps : null;
      renderStatus();
    }
  }, 2000);

  // server log tail (System page)
  const logEl = document.getElementById('logTail');
  if (logEl) {
    pollLoop(async () => {
      const lines = await invoke('log_tail');
      logEl.textContent = Array.isArray(lines) && lines.length
        ? lines.slice().reverse().join('\n')
        : '— no recent output —';
    }, 2000);
  }
});
