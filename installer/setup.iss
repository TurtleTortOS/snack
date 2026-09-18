; SNACK installer (SnackSetup.exe) — Inno Setup 6, ARM64
; Silent: SnackSetup.exe /VERYSILENT /SUPPRESSMSGBOXES
;
; Prereqs on the build machine:
;   runtime\geniex-cli-setup.exe  (pinned, SHA256 in runtime\versions.json)
;   runtime\Qwen3.8-4B.gguf       (pinned, SHA256 in versions.json)
;   runtime\Qwen3.8-9B.gguf       (pinned, SHA256 in versions.json)
;   runtime\Hermes-Setup.exe      (pinned, SHA256 in versions.json)
;   ..\target\release\snack.exe   (built via cargo tauri build)

#define MyAppName "SNACK"
#define MyAppVersion "0.1.0"
#define MyAppPublisher "TurtleTortOS"
#define MyAppExeName "snack.exe"
#define SnackHome "C:\Snack"

[Setup]
AppId={{8C6F2A41-9E3D-4B7A-B2F5-1D0E6C4A9B31}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher={#MyAppPublisher}
DefaultDirName={#SnackHome}
DefaultGroupName={#MyAppName}
ArchitecturesInstallIn64BitMode=x64, arm64
OutputDir=..\dist
OutputBaseFilename=SnackSetup
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
PrivilegesRequired=admin
PrivilegesRequiredOverridesAllowed=dialog

[Files]
; SNACK app (cargo tauri build outputs under src-tauri/target/release)
Source: "..\src-tauri\target\release\{#MyAppExeName}"; DestDir: "{#SnackHome}"; Flags: ignoreversion
; GenieX runtime installer (runs silently)
Source: "runtime\geniex-cli-setup.exe"; DestDir: "C:\Snack\staging"; Flags: deleteafterinstall
; Models — one per directory, file named <ModelId>.gguf (LOAD-BEARING layout)
Source: "runtime\Qwen3.8-4B.gguf"; DestDir: "{#SnackHome}\models\Qwen3.8-4B"; Flags: ignoreversion
Source: "runtime\Qwen3.8-9B.gguf"; DestDir: "{#SnackHome}\models\Qwen3.8-9B"; Flags: ignoreversion
; Hermes installer (runs silently)
Source: "runtime\Hermes-Setup.exe"; DestDir: "C:\Snack\staging"; Flags: deleteafterinstall
; doctor + helper scripts
Source: "scripts\doctor.ps1"; DestDir: "{#SnackHome}\scripts"; Flags: ignoreversion
Source: "scripts\register-models.ps1"; DestDir: "{#SnackHome}\scripts"; Flags: ignoreversion

[Icons]
Name: "{group}\SNACK"; Filename: "{#SnackHome}\{#MyAppExeName}"
Name: "{autodesktop}\SNACK"; Filename: "{#SnackHome}\{#MyAppExeName}"

[Run]
; 1. GenieX runtime -> C:\GenieX (its installer's default location; SNACK
;    points GENIEX_PLUGIN_PATH there). Runs as the current user via the
;    elevation Inno already has.
Filename: "C:\Snack\staging\geniex-cli-setup.exe"; Parameters: "/VERYSILENT /SUPPRESSMSGBOXES /DIR=C:\GenieX"; StatusMsg: "Installing GenieX runtime..."; Flags: runhidden waituntilidle
; 2. Hermes (silent; user-scoped install under the running user)
Filename: "C:\Snack\staging\Hermes-Setup.exe"; Parameters: "/VERYSILENT /SUPPRESSMSGBOXES"; StatusMsg: "Installing Hermes..."; Flags: runhidden waituntilidle
; 3. Register models in the GenieX model manager (localfs pull, isolated dirs)
Filename: "powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{#SnackHome}\scripts\register-models.ps1"""; StatusMsg: "Registering models..."; Flags: runhidden waituntilidle
; 4. Doctor — end on the green checklist
Filename: "powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{#SnackHome}\scripts\doctor.ps1"""; Description: "Run SNACK Doctor (recommended)"; Flags: postinstall nowait skipifsilent

[Registry]
; Auto-start SNACK at logon (the mechanism — no scheduled task in v1)
Root: HKA; Subkey: "Software\Microsoft\Windows\CurrentVersion\Run"; ValueType: string; ValueName: "SNACK"; ValueData: "{#SnackHome}\{#MyAppExeName}"; Flags: uninsdeletevalue

[UninstallRun]
Filename: "powershell.exe"; Parameters: "-NoProfile -Command ""Stop-Process -Name geniex -Force -ErrorAction SilentlyContinue"""; Flags: runhidden

[UninstallDelete]
Type: filesandordirs; Name: "{#SnackHome}"

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"
