param(
  [Parameter(Mandatory = $true)]
  [string]$ExtensionId,

  [string]$Configuration = "release"
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

$RegistryPath = "HKCU:\Software\Google\Chrome\NativeMessagingHosts\com.browsersdk.assistant"
New-Item -Path $RegistryPath -Force | Out-Null
Set-Item -Path $RegistryPath -Value (Resolve-Path -LiteralPath $ManifestPath).Path

Write-Host "Installed native host manifest:"
Write-Host "  $ManifestPath"
Write-Host "Registered Chrome native host:"
Write-Host "  $RegistryPath"
