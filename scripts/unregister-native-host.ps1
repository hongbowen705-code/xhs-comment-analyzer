$ErrorActionPreference = "Stop"
$HostName = "com.xhs_comment_analyzer.prototype"
$RegistryPath = "HKCU:\Software\Google\Chrome\NativeMessagingHosts\$HostName"

if (Test-Path -LiteralPath $RegistryPath) {
  Remove-Item -LiteralPath $RegistryPath -Force
  Write-Host "Native Host registry entry removed. Build artifacts and task data were preserved."
} else {
  Write-Host "Native Host is not registered."
}
