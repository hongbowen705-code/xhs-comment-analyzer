$ErrorActionPreference = "Stop"

$HostName = "com.xhs_comment_analyzer.prototype"
$ExtensionId = "fghibfonhbgiolhahjhagnngpcglgmje"
$RepoRoot = Split-Path -Parent $PSScriptRoot
$HostExe = Join-Path $RepoRoot "apps\native-host\dist\xhs-comment-native-host.exe"
$RuntimeDir = Join-Path $RepoRoot "runtime\native-host"
$ManifestPath = Join-Path $RuntimeDir "$HostName.json"
$RegistryPath = "HKCU:\Software\Google\Chrome\NativeMessagingHosts\$HostName"

if (-not (Test-Path -LiteralPath $HostExe)) {
  throw "Native Host executable not found. Run: npm.cmd run build:native-host"
}

New-Item -ItemType Directory -Path $RuntimeDir -Force | Out-Null
$Manifest = [ordered]@{
  name = $HostName
  description = "XHS Comment Analyzer Prototype Native Host"
  path = $HostExe
  type = "stdio"
  allowed_origins = @("chrome-extension://$ExtensionId/")
}
$Manifest | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $ManifestPath -Encoding utf8
New-Item -Path $RegistryPath -Force | Out-Null
Set-Item -Path $RegistryPath -Value $ManifestPath

Write-Host "Native Host registered for the current user."
Write-Host "Host: $HostExe"
Write-Host "Manifest: $ManifestPath"
Write-Host "Extension ID: $ExtensionId"
