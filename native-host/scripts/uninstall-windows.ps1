param(
  [string]$InstallRoot = "$env:LOCALAPPDATA\BrosdkAssistant",

  [switch]$RemoveSettings,

  [switch]$SkipRegistry
)

$ErrorActionPreference = "Stop"

function Get-FullPath([string]$Path) {
  return [System.IO.Path]::GetFullPath($Path)
}

if (-not $env:LOCALAPPDATA) {
  throw "LOCALAPPDATA is not available."
}
$LocalRoot = (Get-FullPath $env:LOCALAPPDATA).TrimEnd("\")
$InstallRoot = (Get-FullPath $InstallRoot).TrimEnd("\")
if (-not $InstallRoot.StartsWith("$LocalRoot\", [System.StringComparison]::OrdinalIgnoreCase)) {
  throw "InstallRoot must be inside LOCALAPPDATA: $LocalRoot"
}

$StatePath = Join-Path $InstallRoot "install-state.json"
$State = $null
if (Test-Path -LiteralPath $StatePath) {
  try {
    $State = Get-Content -LiteralPath $StatePath -Raw | ConvertFrom-Json
  } catch {
    Write-Warning "Could not read install state: $StatePath"
  }
}

$BrowserRegistryRoots = @(
  "HKCU:\Software\Google\Chrome\NativeMessagingHosts",
  "HKCU:\Software\Microsoft\Edge\NativeMessagingHosts",
  "HKCU:\Software\Chromium\NativeMessagingHosts"
)
if (-not $SkipRegistry) {
  foreach ($Root in $BrowserRegistryRoots) {
    $RegistryPath = Join-Path $Root "com.browsersdk.assistant"
    if (Test-Path $RegistryPath) {
      Remove-Item -Path $RegistryPath -Recurse -Force
      Write-Host "Removed $RegistryPath"
    }
  }
}

if (Test-Path -LiteralPath $InstallRoot) {
  Remove-Item -LiteralPath $InstallRoot -Recurse -Force
  Write-Host "Removed installation files: $InstallRoot"
}

if ($RemoveSettings) {
  $SettingsRoot = Join-Path $env:APPDATA "BrosdkAssistant"
  if (Test-Path -LiteralPath $SettingsRoot) {
    Remove-Item -LiteralPath $SettingsRoot -Recurse -Force
    Write-Host "Removed settings and default workspace: $SettingsRoot"
  }
} else {
  Write-Host "Settings were preserved under %APPDATA%\BrosdkAssistant."
}

if ($State -and $State.extension_id) {
  Write-Host "Remove extension $($State.extension_id) from chrome://extensions or edge://extensions."
} else {
  Write-Host "Remove Brosdk Assistant from the browser extensions page."
}
