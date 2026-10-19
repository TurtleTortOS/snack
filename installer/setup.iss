; SNACK installer (SnackSetup.exe) — Inno Setup 6 (6.3+ for exclusive task groups), ARM64
; Silent: SnackSetup.exe /VERYSILENT /SUPPRESSMSGBOXES
;   Harness choice in silent mode defaults to Hermes; override with
;   /TASKS="harness_pi" or /TASKS="harness_dsh".
;
; Prereqs on the build machine:
;   runtime\geniex-cli-setup.exe  (GenieX v0.8.0 ARM64, pinned SHA256)
;   ..\src-tauri\target\release\snack.exe   (built via cargo tauri build)
;
; Models are OPTIONAL — selected via checkboxes in the wizard.
; They download from HuggingFace (TurtleTortOS/snack-models).
; The chat harness is a CHOICE — Hermes (default), Pi, or DeepSeek Harness.

#define MyAppName "SNACK"
#define MyAppVersion "0.2.0"
#define MyAppPublisher "TurtleTortOS"
#define MyAppExeName "snack.exe"
#define SnackHome "C:\Snack"
#define GenieXVer "v0.8.0"

[Setup]
AppId={{8C6F2A41-9E3D-4B7A-B2F5-1D0E6C4A9B31}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher={#MyAppPublisher}
DefaultDirName={#SnackHome}
DefaultGroupName={#MyAppName}
ArchitecturesInstallIn64BitMode=x64compatible arm64
OutputDir=..\dist
OutputBaseFilename=SnackSetup
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
PrivilegesRequired=admin
PrivilegesRequiredOverridesAllowed=dialog

[Types]
; First entry is the default type. "custom" lets the user toggle model checkboxes.
Name: "basic"; Description: "Basic (SNACK + GenieX + harness, download models later)"
Name: "full"; Description: "Full install (SNACK + GenieX + harness + Models)"
Name: "custom"; Description: "Custom"; Flags: iscustom

[Tasks]
; Exactly one harness (exclusive siblings = mutually exclusive checkboxes).
Name: "harness_hermes"; Description: "Hermes Agent (Nous Research) — recommended default"; GroupDescription: "Chat harness (pick one):"; Flags: exclusive
Name: "harness_pi"; Description: "Pi (pi.dev) — minimal terminal coding harness (needs Node.js)"; Flags: exclusive
Name: "harness_dsh"; Description: "DeepSeek Harness (dsh) — web-UI agent harness (needs Node.js)"; Flags: exclusive

[Components]
Name: "app"; Description: "SNACK app"; Types: full basic; Flags: fixed
Name: "geniex"; Description: "GenieX runtime {#GenieXVer}"; Types: full basic; Flags: fixed
Name: "model4b"; Description: "Qwen3.8-4B model (~2.4 GB) — FAST"; Types: full
Name: "model9b"; Description: "Qwen3.8-9B model (~5.1 GB) — SMART"; Types: full
Name: "scripts"; Description: "Doctor + helper scripts"; Types: full basic; Flags: fixed

[Files]
; SNACK app
Source: "..\src-tauri\target\release\{#MyAppExeName}"; DestDir: "{#SnackHome}"; Flags: ignoreversion
; GenieX runtime installer
Source: "runtime\geniex-cli-setup.exe"; DestDir: "C:\Snack\staging"; Flags: deleteafterinstall
; Models — one per directory, file named <ModelId>.gguf (LOAD-BEARING layout)
Source: "runtime\Qwen3.8-4B.gguf"; DestDir: "{#SnackHome}\models\Qwen3.8-4B"; Flags: ignoreversion; Components: model4b
Source: "runtime\Qwen3.8-9B.gguf"; DestDir: "{#SnackHome}\models\Qwen3.8-9B"; Flags: ignoreversion; Components: model9b
; doctor + helper scripts
Source: "scripts\doctor.ps1"; DestDir: "{#SnackHome}\scripts"; Flags: ignoreversion
Source: "scripts\register-models.ps1"; DestDir: "{#SnackHome}\scripts"; Flags: ignoreversion
; harness endpoint config writer (Pi models.json / dsh settings.yaml / config.json)
Source: "scripts\configure-harness.ps1"; DestDir: "{#SnackHome}\scripts"; Flags: ignoreversion

[Icons]
Name: "{group}\SNACK"; Filename: "{#SnackHome}\{#MyAppExeName}"
Name: "{autodesktop}\SNACK"; Filename: "{#SnackHome}\{#MyAppExeName}"
Name: "{group}\DeepSeek Harness"; Filename: "{sysnative}\cmd.exe"; Parameters: "/C start /min npx @deepseek-ai/dsh web"; IconFilename: "{#SnackHome}\{#MyAppExeName}"; Tasks: harness_dsh

[Run]
; 1. GenieX runtime -> C:\GenieX (silent; pinned SHA256 verified before build)
Filename: "C:\Snack\staging\geniex-cli-setup.exe"; Parameters: "/VERYSILENT /SUPPRESSMSGBOXES /DIR=C:\GenieX"; StatusMsg: "Installing GenieX runtime {#GenieXVer}..."; Flags: runhidden waituntilidle
; 2a. Hermes — via install script (always latest, no download needed)
Filename: "powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -Command ""irm https://hermes-agent.nousresearch.com/install.ps1 | iex"""; StatusMsg: "Installing Hermes Agent..."; Flags: runhidden waituntilidle; Tasks: harness_hermes
; 2b. Pi — official installer (installs Node.js too if missing)
Filename: "powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -Command ""irm https://pi.dev/install.ps1 | iex"""; StatusMsg: "Installing Pi harness..."; Flags: runhidden waituntilidle; Tasks: harness_pi
; 2c. DeepSeek Harness — npm global install
Filename: "{sysnative}\npm.cmd"; Parameters: "install -g @deepseek-ai/dsh"; StatusMsg: "Installing DeepSeek Harness..."; Flags: runhidden waituntilidle; Tasks: harness_dsh
; 2d. Point the selected harness at the SNACK endpoint (Pi / dsh) + record the
;     choice in C:\Snack\config.json
Filename: "powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{#SnackHome}\scripts\configure-harness.ps1"" -Harness {code:GetHarnessName}"; StatusMsg: "Configuring harness endpoint..."; Flags: runhidden waituntilidle; Tasks: harness_pi harness_dsh
; 3. Register models in the GenieX model manager (only if models are selected)
Filename: "powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{#SnackHome}\scripts\register-models.ps1"""; StatusMsg: "Registering models..."; Flags: runhidden waituntilidle; Components: model4b model9b
; 4. Doctor — end on the green checklist
Filename: "powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{#SnackHome}\scripts\doctor.ps1"""; Description: "Run SNACK Doctor (recommended)"; Flags: postinstall nowait skipifsilent

[Registry]
; Auto-start SNACK at logon
Root: HKA; Subkey: "Software\Microsoft\Windows\CurrentVersion\Run"; ValueType: string; ValueName: "SNACK"; ValueData: "{#SnackHome}\{#MyAppExeName}"; Flags: uninsdeletevalue

[UninstallRun]
Filename: "powershell.exe"; Parameters: "-NoProfile -Command ""Stop-Process -Name geniex -Force -ErrorAction SilentlyContinue"""; Flags: runhidden; RunOnceId: "stopgeniex"

[UninstallDelete]
Type: filesandordirs; Name: "{#SnackHome}"

[Code]
var
  NodeChecked: Boolean;

// Name of the selected harness: hermes | pi | dsh (used by {code:...} params).
function GetHarnessName(Param: String): String;
begin
  if WizardIsTaskSelected('harness_pi') then Result := 'pi'
  else if WizardIsTaskSelected('harness_dsh') then Result := 'dsh'
  else Result := 'hermes';
end;

// Gate [Run]/[Icons]/[Registry] entries on the selected harness.
function ShouldPageTasks(Tasks: String): Boolean;
var
  H: String;
begin
  H := GetHarnessName('');
  if Pos('harness_hermes', Tasks) > 0 then Result := (H = 'hermes')
  else if Pos('harness_pi', Tasks) > 0 then Result := (H = 'pi')
  else if Pos('harness_dsh', Tasks) > 0 then Result := (H = 'dsh')
  else Result := True;
end;

// Ensure Node.js exists when a Node-based harness is chosen (Pi's own
// installer handles Node; this covers the dsh path and odd Pi failures).
// ssPostInstall fires after files are in place but before [Run] entries.
procedure CurStepChanged(CurStep: TSetupStep);
var
  ResultCode: Integer;
begin
  if (CurStep = ssPostInstall) and not NodeChecked then
  begin
    NodeChecked := True;
    if GetHarnessName('') <> 'hermes' then
    begin
      if not Exec(ExpandConstant('{sysnative}\cmd.exe'), '/C where node >nul 2>&1', '', SW_HIDE,
                  ewWaitUntilTerminated, ResultCode) or (ResultCode <> 0) then
      begin
        Log('Node.js not found — installing via winget');
        Exec(ExpandConstant('{sysnative}\cmd.exe'), '/C winget install -e --id OpenJS.NodeJS.LTS --accept-package-agreements --silent', '',
             SW_HIDE, ewWaitUntilTerminated, ResultCode);
      end;
    end;
  end;
end;

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"
