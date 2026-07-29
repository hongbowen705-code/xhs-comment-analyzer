$ErrorActionPreference = "Stop"

$HostName = "com.xhs_comment_analyzer.prototype"
$ExtensionId = "fghibfonhbgiolhahjhagnngpcglgmje"
$RepoRoot = Split-Path -Parent $PSScriptRoot
$RegistryPath = "HKCU:\Software\Google\Chrome\NativeMessagingHosts\$HostName"
$ChromePaths = @(
  "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
  "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
  "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe"
)

$Chrome = $ChromePaths | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
$RegistryExists = Test-Path -LiteralPath $RegistryPath
$ManifestPath = if ($RegistryExists) { (Get-Item -LiteralPath $RegistryPath).GetValue("") } else { $null }
$ManifestExists = $ManifestPath -and (Test-Path -LiteralPath $ManifestPath)
$Manifest = if ($ManifestExists) { Get-Content -LiteralPath $ManifestPath -Raw | ConvertFrom-Json } else { $null }
$HostExists = $Manifest -and (Test-Path -LiteralPath $Manifest.path)
$OriginOk = $Manifest -and ($Manifest.allowed_origins -contains "chrome-extension://$ExtensionId/")

[pscustomobject]@{
  ChromeFound = [bool]$Chrome
  ChromePath = $Chrome
  RegistryEntry = $RegistryExists
  ManifestFound = [bool]$ManifestExists
  HostExecutableFound = [bool]$HostExists
  AllowedOriginCorrect = [bool]$OriginOk
  ExtensionId = $ExtensionId
} | Format-List

if (-not ($Chrome -and $RegistryExists -and $ManifestExists -and $HostExists -and $OriginOk)) {
  exit 1
}
