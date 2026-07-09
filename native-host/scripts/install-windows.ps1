param(
  [Parameter(Mandatory = $true)]
  [string]$ExtensionId,

  [string]$Configuration = "release",

  [ValidateSet("Chrome", "Edge", "Chromium")]
  [string[]]$Browsers = @("Chrome", "Edge", "Chromium")
)

$ErrorActionPreference = "Stop"

$Root = Resolve-Path (Join-Path $PSScriptRoot "..")
$ExeName = "brosdk-assistant-native.exe"
$ExePath = Join-Path $Root "target\$Configuration\$ExeName"

if (-not (Test-Path -LiteralPath $ExePath)) {
  throw "Native host executable not found: $ExePath. Run cargo build --release first."
}

$ManifestPath = Join-Path $Root "native-host-manifest.json"
$Manifest = [ordered]@{
  name = "com.browsersdk.assistant"
  description = "Brosdk Assistant Native Host"
  path = (Resolve-Path -LiteralPath $ExePath).Path
  type = "stdio"
  allowed_origins = @("chrome-extension://$ExtensionId/")
}

$Manifest | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $ManifestPath -Encoding UTF8

$BrowserRegistryRoots = @{
  Chrome = "HKCU:\Software\Google\Chrome\NativeMessagingHosts"
  Edge = "HKCU:\Software\Microsoft\Edge\NativeMessagingHosts"
  Chromium = "HKCU:\Software\Chromium\NativeMessagingHosts"
}

$RegisteredPaths = foreach ($Browser in $Browsers) {
  $RegistryPath = Join-Path $BrowserRegistryRoots[$Browser] "com.browsersdk.assistant"
  New-Item -Path $RegistryPath -Force | Out-Null
  Set-Item -Path $RegistryPath -Value (Resolve-Path -LiteralPath $ManifestPath).Path
  $RegistryPath
}

Write-Host "Installed native host manifest:"
Write-Host "  $ManifestPath"
Write-Host "Registered native host:"
$RegisteredPaths | ForEach-Object { Write-Host "  $_" }
