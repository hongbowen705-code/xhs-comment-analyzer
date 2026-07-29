$ErrorActionPreference = "Stop"
$HostName = "com.xhs_comment_analyzer.prototype"
$ExtensionId = "fghibfonhbgiolhahjhagnngpcglgmje"
$RegistryPath = "HKCU:\Software\Google\Chrome\NativeMessagingHosts\$HostName"
$ChromePaths = @(
  "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
  "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
  "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe"
)
$Chrome = $ChromePaths | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
$ManifestPath = if (Test-Path -LiteralPath $RegistryPath) {
  [string](Get-Item -LiteralPath $RegistryPath).GetValue("")
} else { $null }
$Manifest = if ($ManifestPath -and (Test-Path -LiteralPath $ManifestPath)) {
  Get-Content -LiteralPath $ManifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
} else { $null }

[pscustomobject]@{
  CheckedAt = (Get-Date).ToString("o")
  ChromeFound = [bool]$Chrome
  RegistryEntry = [bool]$ManifestPath
  ManifestFound = [bool]$Manifest
  HostExecutableFound = [bool]($Manifest -and (Test-Path -LiteralPath $Manifest.path))
  AllowedOriginCorrect = [bool]($Manifest -and ($Manifest.allowed_origins -contains "chrome-extension://$ExtensionId/"))
  RegisteredManifestPath = $ManifestPath
  RegisteredHostPath = if ($Manifest) { $Manifest.path } else { $null }
  PlatformWriteCount = 0
} | Format-List
