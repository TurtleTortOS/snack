# Building SNACK on the Surface (ARM64 Windows)

SNACK must be built **on the target device class** (aarch64 Windows). Cross-compiling
Tauri + WebView2 from x86 is not worth it.

## One-time toolchain setup

```powershell
# 1. rustup (native MSVC toolchain — NOT the choco x86_64-pc-windows-gnu one)
winget install Rustlang.Rustup
rustup default aarch64-pc-windows-msvc

# 2. MSVC linker (Tauri on Windows links with link.exe)
winget install Microsoft.VisualStudio.2022.BuildTools
#    workloads: "Desktop development with C++" (MSVC v143 + Windows 11 SDK)

# 3. WebView2 runtime (usually preinstalled on modern Windows 11; verify)
#    HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}

# 4. Tauri CLI
cargo install tauri-cli --version "^2" --locked
```

> Note: the choco `rust` package on the pilot Surface is `x86_64-pc-windows-gnu` (emulated).
> It can run `cargo check`-ish work but is **not** the toolchain for a Tauri ARM64 build.
> `rustup` installs alongside it; put the rustup `~/.cargo/bin` earlier in PATH.

## Build

```powershell
cd C:\Snack-src\snack        # repo checkout
cargo tauri dev              # iterate: hot-reloads ui/, spawns the app window
cargo tauri build            # release: target\release\snack.exe + NSIS installer
```

The crate is in `src-tauri/` (standard Tauri 2 layout). To type-check without the
Tauri CLI: `cd src-tauri; cargo check`.

## Dev without the shell

`ui/index.html` is self-contained (no build step). Open it in Edge/Chrome to review the
UI: it detects it's not in Tauri and runs a labeled **demo mode** (in-memory state, fake
server). All four panels, the toggle, model cards, context steppers, copy buttons, and
Doctor render and interact.

## Smoke checklist after a build

1. `snack.exe` launches; Home shows `stopped`.
2. Toggle on → `warming`, then `running` (~30 s) with GenieX server live on 18181.
3. Models → Select 4B → `warming` → `running`; `/v1/models` still lists both IDs.
4. System → Run Doctor → all green (server-dependent rows green only while on).
5. Launch Chat → Hermes opens, pointed at the selected model.
6. Toggle off → `stopped`, `geniex.exe` no longer in the process list.
