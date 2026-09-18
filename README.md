# SNACK — Snapdragon NPU AI Chat Kit

A local AI kit for Snapdragon Surfaces. The model runs on the **NPU** (not the CPU or GPU)
via Qualcomm's [GenieX](https://github.com/qualcomm/GenieX) runtime, exposed through a
standard OpenAI-compatible endpoint on `127.0.0.1:18181`.

**SNACK** is the control center (a small Tauri desktop app): start/stop the server, pick
which model runs, set context length, run diagnostics, and launch [Hermes](https://hermes-agent.nousresearch.com)
for chat.

> Target: Microsoft Surface (Snapdragon X Plus, X1P42100), Windows ARM64, 16 GB RAM.
> v1 ships two models: **Qwen3.8-4B** (fast) and **Qwen3.8-9B** (smart), Q4_0 GGUF, 64k context.

## Layout

```
C:\Snack\
├── snack.exe                 SNACK control center (this app)
├── config.json               { model, nctx, port }  — the entire app state
├── geniex\                   GenieX 0.6.1 runtime (BSD-3)
│   └── geniex.exe            serve --compute npu --host 127.0.0.1:18181
└── models\                   one directory per model (load-bearing layout)
    ├── Qwen3.8-4B\Qwen3.8-4B.gguf
    └── Qwen3.8-9B\Qwen3.8-9B.gguf
```

## Quickstart (installed)

1. Run `SnackSetup.exe` (installs runtime + models + SNACK + Hermes, ends on a green Doctor checklist).
2. Open **SNACK** → toggle the server on (first start ~30 s while the server comes up).
3. Pick **9B (Smart)** or **4B (Fast)**, set context, **Launch Chat**.
4. Point any tool at `http://127.0.0.1:18181/v1` (System tab → copy).

## The endpoint (for the rest of the machine)

```sh
curl http://127.0.0.1:18181/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "qualcomm/Qwen3.8-9B",
    "messages": [{"role":"user","content":"Hello"}],
    "max_tokens": 64
  }'
```

Model IDs: `qualcomm/Qwen3.8-4B`, `qualcomm/Qwen3.8-9B`. Anything that speaks OpenAI
chat completions works: IDEs, LM Studio, scripts.

## Building from source (on the Surface — ARM64 Windows)

```powershell
# toolchain (one-time): rustup + MSVC linker + WebView2 runtime
#   rustup default aarch64-pc-windows-msvc   (see docs/BUILD.md)

cargo tauri dev      # dev window (loads ui/ directly)
cargo tauri build    # release .exe + NSIS installer
```

The frontend is plain HTML/CSS/JS (`ui/`) — no node/npm needed. You can open
`ui/index.html` directly in a browser to review the UI (it runs in a labeled **demo mode**
with in-memory state; all the same panels and interactions work).

## Doctor

The **System** tab runs the same checklist the installer ends with:

NPU present → GenieX intact → model files → model-manager IDs → server on port →
inference smoke test → Hermes installed. Each failure carries a one-line fix.

## Load-bearing details (do not regress)

- **One model per directory, file named `<ModelId>.gguf`.** A shared directory poisons the
  GenieX `localfs` pull cache (a different model ID gets linked to the wrong file). The
  layout above is the fix.
- **The server resolves model IDs, never paths.** Requests carry `qualcomm/Qwen3.8-9B`;
  raw file paths in the JSON body break its hub parser.
- **Forward slashes** in any path that goes into a JSON body.
- **One model resident at a time.** Selecting another model shows "warming up" until the
  first token (~15 s 4B / ~30 s 9B).
- **Loopback only.** GenieX binds `127.0.0.1` and refuses external hosts.

## Scope (v1)

Two models, fixed. Toggle, model picker, context stepper, endpoint + copy, Doctor,
Launch Chat. Model install/uninstall and a larger catalog land in v1.5.
Out of scope: MTP speculative decoding (GenieX 0.6.1 runtime bug, parked), remote access,
non-Snapdragon hardware, cloud of any kind.

## License

Apache-2.0 (this repo). Bundled components: GenieX 0.6.1 (BSD-3-Clause), Qwen3.8 models
(Apache-2.0, see model cards for attribution), Hermes (its own license).
