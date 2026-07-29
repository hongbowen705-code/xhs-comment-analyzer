$ErrorActionPreference = "Stop"

$RepoRoot = Split-Path -Parent $PSScriptRoot
$Npm = (Get-Command npm.cmd -ErrorAction Stop).Source
$Launcher = Join-Path $RepoRoot "启动小红书评论分析工具.cmd"
$ExtensionDir = Join-Path $RepoRoot "apps\extension\dist"
$DefaultData = "D:\XHSCommentAnalyzer\prototype"

Write-Host "[1/5] 检查依赖"
if (-not (Test-Path -LiteralPath (Join-Path $RepoRoot "node_modules"))) {
  & $Npm install --prefix $RepoRoot
  if ($LASTEXITCODE -ne 0) { throw "npm install 失败" }
}

Write-Host "[2/5] 自动测试"
& $Npm test --prefix $RepoRoot -- --run
if ($LASTEXITCODE -ne 0) { throw "自动测试未通过，已停止安装" }

Write-Host "[3/5] 构建桌面端、扩展和 Native Host"
& $Npm run build --prefix $RepoRoot
if ($LASTEXITCODE -ne 0) { throw "构建失败" }

Write-Host "[4/5] 注册当前用户级 Native Messaging Host"
& (Join-Path $PSScriptRoot "register-native-host.ps1")
& (Join-Path $PSScriptRoot "diagnose-native-host.ps1")
if ($LASTEXITCODE -ne 0) { throw "Native Messaging 诊断未通过" }

Write-Host "[5/5] 创建数据目录和桌面快捷方式"
if (Test-Path -LiteralPath "D:\") {
  New-Item -ItemType Directory -Path $DefaultData -Force | Out-Null
}
$Desktop = [Environment]::GetFolderPath("Desktop")
$Shell = New-Object -ComObject WScript.Shell
$Shortcut = $Shell.CreateShortcut((Join-Path $Desktop "小红书评论分析工具.lnk"))
$Shortcut.TargetPath = $Launcher
$Shortcut.WorkingDirectory = $RepoRoot
$Shortcut.Description = "启动小红书评论分析工具开发版"
$Shortcut.Save()

Write-Host ""
Write-Host "开发版安装/更新完成。"
Write-Host "桌面快捷方式：$(Join-Path $Desktop '小红书评论分析工具.lnk')"
Write-Host "Chrome 扩展目录：$ExtensionDir"
Write-Host "请在 chrome://extensions 中加载或刷新该目录。"
