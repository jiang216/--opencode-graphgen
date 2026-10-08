# 把 graphgen+doclint 全局引导器（技能 + 插件）安装到本机 ~/.config/opencode/
# 用法: pwsh -File install-bootstrap.ps1
# 装一次即可：之后任意项目拷入 opencode-graphgen/（或 legacy graphgen-dist/）并在 opencode 打开，即自动安装全家桶。
$ErrorActionPreference = 'Stop'
$src = Split-Path -Parent $MyInvocation.MyCommand.Path
$cfg = Join-Path $HOME '.config\opencode'
$skDir = Join-Path $cfg 'skills\graphgen-bootstrap'
$plDir = Join-Path $cfg 'plugins'
New-Item -ItemType Directory -Force -Path $skDir, $plDir | Out-Null
Copy-Item -Force (Join-Path $src 'skill-graphgen-bootstrap.md') (Join-Path $skDir 'SKILL.md')
Copy-Item -Force (Join-Path $src 'plugin-graphgen-bootstrap.ts') (Join-Path $plDir 'graphgen-bootstrap.ts')
Write-Host "[graphgen-bootstrap] 已安装到本机全局层:"
Write-Host "  $skDir\SKILL.md"
Write-Host "  $plDir\graphgen-bootstrap.ts"
Write-Host "[graphgen-bootstrap] 请重启 opencode 生效。之后任意项目出现 opencode-graphgen/ 即自动安装全家桶。"
