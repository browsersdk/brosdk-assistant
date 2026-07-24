param(
  [ValidatePattern("^[a-p]{32}$")]
  [string]$ExtensionId,

  [string]$Configuration = "release",

  [ValidateSet("Chrome", "Edge", "Chromium")]
  [string[]]$Browsers = @("Chrome"),

  [string]$InstallRoot = "$env:LOCALAPPDATA\BrosdkAssistant",

  [switch]$NoPrompt,

  [switch]$SkipRegistry
)

$ErrorActionPreference = "Stop"

function Get-FullPath([string]$Path) {
  return [System.IO.Path]::GetFullPath($Path)
}

function Assert-InstallRoot([string]$Path) {
  if (-not $env:LOCALAPPDATA) {
    throw "LOCALAPPDATA is not available."
  }
  $LocalRoot = (Get-FullPath $env:LOCALAPPDATA).TrimEnd("\")
  $Resolved = (Get-FullPath $Path).TrimEnd("\")
  if (-not $Resolved.StartsWith("$LocalRoot\", [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "InstallRoot must be inside LOCALAPPDATA: $LocalRoot"
  }
  return $Resolved
}

function Find-ExtensionSource([string]$PackageRoot) {
  $Candidates = @(
    (Join-Path $PackageRoot "extension\chrome-mv3"),
    (Join-Path $PackageRoot "extension\dist\chrome-mv3")
  )
  foreach ($Candidate in $Candidates) {
    if (Test-Path -LiteralPath (Join-Path $Candidate "manifest.json")) {
      return (Resolve-Path -LiteralPath $Candidate).Path
    }
  }
  throw "Built extension not found. Expected extension\chrome-mv3 in a release package or extension\dist\chrome-mv3 in the repository."
}

function Read-InstallState([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path)) {
    return $null
  }
  try {
    return Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json
  } catch {
    Write-Warning "Ignoring invalid install state: $Path"
    return $null
  }
}

$NativeSourceRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$PackageRoot = (Resolve-Path (Join-Path $NativeSourceRoot "..")).Path
$ExeName = "brosdk-assistant-native.exe"
$SourceExe = Join-Path $NativeSourceRoot "target\$Configuration\$ExeName"
if (-not (Test-Path -LiteralPath $SourceExe)) {
  throw "Native host executable not found: $SourceExe"
}

$ExtensionSource = Find-ExtensionSource $PackageRoot
$SourceManifest = Get-Content -LiteralPath (Join-Path $ExtensionSource "manifest.json") -Raw | ConvertFrom-Json
$Version = [string]$SourceManifest.version
if (-not $Version) {
  throw "Extension manifest does not contain a version."
}

$InstallRoot = Assert-InstallRoot $InstallRoot
$StatePath = Join-Path $InstallRoot "install-state.json"
$PreviousState = Read-InstallState $StatePath
if (-not $PSBoundParameters.ContainsKey("Browsers") -and $PreviousState -and $PreviousState.browsers) {
  $Browsers = @($PreviousState.browsers)
}
if (-not $ExtensionId -and $PreviousState -and $PreviousState.extension_id -match "^[a-p]{32}$") {
  $ExtensionId = [string]$PreviousState.extension_id
}

$ExtensionDestination = Join-Path $InstallRoot "extension\chrome-mv3"
$NativeDestination = Join-Path $InstallRoot "native-host\$Version"
$InstalledExe = Join-Path $NativeDestination $ExeName
$ManifestPath = Join-Path $InstallRoot "native-host-manifest.json"

New-Item -ItemType Directory -Path $InstallRoot -Force | Out-Null
if (Test-Path -LiteralPath $ExtensionDestination) {
  $ResolvedExtensionDestination = Get-FullPath $ExtensionDestination
  if (-not $ResolvedExtensionDestination.StartsWith("$InstallRoot\", [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to replace extension outside the install root: $ResolvedExtensionDestination"
  }
  Remove-Item -LiteralPath $ResolvedExtensionDestination -Recurse -Force
}
New-Item -ItemType Directory -Path (Split-Path $ExtensionDestination -Parent) -Force | Out-Null
Copy-Item -LiteralPath $ExtensionSource -Destination $ExtensionDestination -Recurse -Force
New-Item -ItemType Directory -Path $NativeDestination -Force | Out-Null
Copy-Item -LiteralPath $SourceExe -Destination $InstalledExe -Force
Copy-Item -LiteralPath $PSCommandPath -Destination (Join-Path $InstallRoot "install-windows.ps1") -Force
$UninstallSource = Join-Path $PSScriptRoot "uninstall-windows.ps1"
if (Test-Path -LiteralPath $UninstallSource) {
  Copy-Item -LiteralPath $UninstallSource -Destination (Join-Path $InstallRoot "uninstall-windows.ps1") -Force
}

if (-not $ExtensionId) {
  Write-Host ""
  Write-Host "Extension files installed to:"
  Write-Host "  $ExtensionDestination"
  Write-Host ""
  Write-Host "Open chrome://extensions, enable Developer mode, and choose Load unpacked."
  Write-Host "Select the directory above, then copy the generated extension ID."
  if ($NoPrompt) {
    throw "ExtensionId is required for a first installation when NoPrompt is set."
  }
  $ExtensionId = (Read-Host "Extension ID").Trim()
}
if ($ExtensionId -notmatch "^[a-p]{32}$") {
  throw "ExtensionId must contain exactly 32 letters in the range a-p."
}

$Manifest = [ordered]@{
  name = "com.browsersdk.assistant"
  description = "Brosdk Assistant Native Host"
  path = (Resolve-Path -LiteralPath $InstalledExe).Path
  type = "stdio"
  allowed_origins = @("chrome-extension://$ExtensionId/")
}
$Manifest | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $ManifestPath -Encoding UTF8

$BrowserRegistryRoots = @{
  Chrome = "HKCU:\Software\Google\Chrome\NativeMessagingHosts"
  Edge = "HKCU:\Software\Microsoft\Edge\NativeMessagingHosts"
  Chromium = "HKCU:\Software\Chromium\NativeMessagingHosts"
}
$RegisteredPaths = @()
if (-not $SkipRegistry) {
  $RegisteredPaths = foreach ($Browser in $Browsers) {
    $RegistryPath = Join-Path $BrowserRegistryRoots[$Browser] "com.browsersdk.assistant"
    New-Item -Path $RegistryPath -Force | Out-Null
    Set-Item -Path $RegistryPath -Value (Resolve-Path -LiteralPath $ManifestPath).Path
    $RegistryPath
  }
}

$State = [ordered]@{
  version = $Version
  extension_id = $ExtensionId
  extension_path = $ExtensionDestination
  native_host_path = $InstalledExe
  browsers = @($Browsers)
}
$State | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $StatePath -Encoding UTF8

Write-Host ""
Write-Host "Brosdk Assistant $Version installed."
Write-Host "Extension directory:"
Write-Host "  $ExtensionDestination"
Write-Host "Native host manifest:"
Write-Host "  $ManifestPath"
if ($SkipRegistry) {
  Write-Host "Registry registration skipped."
} else {
  Write-Host "Registered native host:"
  $RegisteredPaths | ForEach-Object { Write-Host "  $_" }
}
Write-Host ""
Write-Host "Reload the extension, then open its options page."
