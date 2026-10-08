# CCST 一键安装（Windows）：由 CCST安装.bat 调用，也可以右键 -> 用 PowerShell 运行。可以重复运行（相当于更新）。
# 做的事：找到酒馆文件夹 -> 检查 Node.js -> 打开酒馆的「插件开关」（先备份）-> 装 CCST -> 装依赖 -> 登录 Claude。
# 不会删除你的任何数据。兼容 Windows PowerShell 5.1。文件必须保存为 UTF-8（带 BOM）。
# 测试用环境变量（平时不用）：CCST_ST_DIR 指定酒馆文件夹；CCST_NO_PROCESS_SCAN=1 不去找正在运行的酒馆；
#   CCST_SKIP_LOGIN=1 跳过登录；CCST_YES=1 不问问题；CCST_REPO_URL / CCST_ZIP_URL 换下载地址；
#   CCST_BRANCH 指定分支（默认用仓库默认分支）。

$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false) } catch { }
$RepoUrl = if ($env:CCST_REPO_URL) { $env:CCST_REPO_URL } else { 'https://github.com/kcgoofee-jpg/CCST' }
$Branch = $env:CCST_BRANCH
$ZipBranch = if ($Branch) { $Branch } else { 'main' }
$ZipUrl = if ($env:CCST_ZIP_URL) { $env:CCST_ZIP_URL } else { "https://github.com/kcgoofee-jpg/CCST/archive/refs/heads/$ZipBranch.zip" }
$AssumeYes = ($env:CCST_YES -eq '1')
$Stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 } catch { }

function Say($m) { Write-Host $m }
function Ok($m) { Write-Host "  [OK] $m" -ForegroundColor Green }
function Warn($m) { Write-Host "  [!] $m" -ForegroundColor Yellow }
function Step($m) { Write-Host ''; Write-Host "【$m】" -ForegroundColor Cyan }
function Finish($code) {
    Write-Host ''
    if ($Log) { try { Stop-Transcript | Out-Null } catch { } }
    if (-not $AssumeYes) { Read-Host '按回车键关闭这个窗口' | Out-Null }
    exit $code
}
function Stop-With($msg, [string[]]$lines) {
    Write-Host ''
    Write-Host "[失败] $msg" -ForegroundColor Red
    foreach ($l in $lines) { Write-Host "  $l" }
    if ($Log) { Write-Host "  还不行就把桌面上的「CCST安装日志.txt」发给作者。" }
    Finish 1
}
# 运行外部程序（npm、git 等）；它们往 stderr 写警告不算失败，只看退出码
function Run-Native([scriptblock]$block) {
    $old = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
    try { & $block | Out-Host; return $LASTEXITCODE } finally { $ErrorActionPreference = $old }
}

# 日志：屏幕上的每一行同时写进桌面的「CCST安装日志.txt」（每次覆盖），出问题时发这个文件
$Log = Join-Path ([Environment]::GetFolderPath('Desktop')) 'CCST安装日志.txt'
try { Start-Transcript -Path $Log -Force | Out-Null; Write-Host ("{0}  Windows {1}  PowerShell {2}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), [Environment]::OSVersion.Version, $PSVersionTable.PSVersion) } catch { $Log = $null }
Write-Host '════════ CCST 一键安装 ════════'
Say '这个程序会帮你把 CCST 装进酒馆。中间可能要等几分钟，请不要关窗口。'

# ── 1. 找酒馆文件夹 ──
function Test-St($d) {
    if (-not $d -or -not (Test-Path -LiteralPath $d -PathType Container)) { return $false }
    $pj = Join-Path $d 'package.json'
    if (-not (Test-Path -LiteralPath (Join-Path $d 'server.js')) -or -not (Test-Path -LiteralPath $pj)) { return $false }
    return [bool](Select-String -LiteralPath $pj -Pattern '"name":\s*"sillytavern"' -Quiet)
}
function Has-Ext($d) {
    if (Test-Path -LiteralPath (Join-Path $d 'public\scripts\extensions\third-party\CCST')) { return $true }
    return [bool](Get-ChildItem -Path (Join-Path $d 'data\*\extensions\CCST') -Directory -ErrorAction SilentlyContinue)
}
function Clean-Input($s) {
    $s = "$s".Trim()
    if ($s.Length -ge 2 -and (($s[0] -eq '"' -and $s[-1] -eq '"') -or ($s[0] -eq "'" -and $s[-1] -eq "'"))) { $s = $s.Substring(1, $s.Length - 2) }
    return $s.Trim()
}

Step '1/6 找到酒馆（SillyTavern）文件夹'
$St = $null
if ($env:CCST_ST_DIR) {
    if (Test-St $env:CCST_ST_DIR) { $St = (Resolve-Path -LiteralPath $env:CCST_ST_DIR).Path }
    else { Stop-With "指定的文件夹不是酒馆：$($env:CCST_ST_DIR)" @('请确认它里面有 server.js 和 package.json。') }
} else {
    $found = New-Object System.Collections.Generic.List[string]
    function Add-Cand($d) {
        if (Test-St $d) { $p = (Resolve-Path -LiteralPath $d).Path.TrimEnd('\'); if (-not ($found -contains $p)) { $found.Add($p) } }
    }
    if ($env:CCST_NO_PROCESS_SCAN -ne '1') { # 正在运行的酒馆：命令行里写了 server.js 完整路径的
        try {
            Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction Stop | ForEach-Object {
                if ($_.CommandLine -match '"?([A-Za-z]:\\[^"]*?)\\server\.js') { Add-Cand $Matches[1] }
            }
        } catch { }
    }
    $home_ = [Environment]::GetFolderPath('UserProfile')
    $desk = [Environment]::GetFolderPath('Desktop')
    $docs = [Environment]::GetFolderPath('MyDocuments')
    $cands = @("$home_\SillyTavern", "$desk\SillyTavern", "$docs\SillyTavern", "$home_\Downloads\SillyTavern", 'C:\SillyTavern', 'D:\SillyTavern', 'E:\SillyTavern', 'F:\SillyTavern')
    foreach ($base in @("$home_\Downloads", $desk, $docs, $home_, 'C:\', 'D:\', 'E:\', 'F:\')) {
        if (Test-Path -LiteralPath $base) {
            Get-ChildItem -LiteralPath $base -Directory -ErrorAction SilentlyContinue | Where-Object { $_.Name -like 'SillyTavern*' -or $base -like '*Downloads' } | ForEach-Object {
                $cands += $_.FullName; $cands += (Join-Path $_.FullName 'SillyTavern')
            }
        }
    }
    foreach ($c in $cands) { Add-Cand $c }
    $withExt = @($found | Where-Object { Has-Ext $_ })
    if ($withExt.Count -ge 1 -and $withExt.Count -lt $found.Count) { $found = New-Object System.Collections.Generic.List[string](,[string[]]$withExt) }
    if ($found.Count -eq 1) { $St = $found[0] }
    elseif ($found.Count -gt 1) {
        Say '找到了不止一个酒馆：'
        for ($i = 0; $i -lt $found.Count; $i++) { Say ("  {0}) {1}" -f ($i + 1), $found[$i]) }
        if ($AssumeYes) { Stop-With '找到不止一个酒馆，没法自动选。' @('用 CCST_ST_DIR 指定其中一个。') }
        while (-not $St) {
            $a = Clean-Input (Read-Host '输入数字选一个；或者把要用的酒馆文件夹拖进这个窗口，再按回车')
            $n = 0
            if ([int]::TryParse($a, [ref]$n) -and $n -ge 1 -and $n -le $found.Count) { $St = $found[$n - 1] }
            elseif (Test-St $a) { $St = (Resolve-Path -LiteralPath $a).Path }
            else { Warn '这个不是酒馆文件夹（里面要有 server.js）。再试一次。' }
        }
    } else {
        Say '没有自动找到酒馆。'
        if ($AssumeYes) { Stop-With '没有找到酒馆文件夹。' @('用 CCST_ST_DIR 指定。') }
        Say '请把酒馆文件夹（里面有 server.js、Start.bat 的那个）从资源管理器拖进这个窗口，再按回车。'
        while (-not $St) {
            $a = Clean-Input (Read-Host '酒馆文件夹')
            if (-not $a) { Warn '没有输入。想放弃就直接关掉这个窗口。'; continue }
            if (Test-St $a) { $St = (Resolve-Path -LiteralPath $a).Path } else { Warn '这个不是酒馆文件夹（里面要有 server.js）。再试一次。' }
        }
    }
}
Ok "酒馆在：$St"
if (-not (Has-Ext $St)) { Warn '酒馆里还没有 CCST 面板：下次启动酒馆时会自动装上，不用管。' }

# 已经是最新版（插件和面板都没有新提交、依赖在）：酒馆开着也不用关
function Test-UpToDate([string]$dir) {
    if (-not (Test-Path -LiteralPath (Join-Path $dir '.git')) -or -not (Get-Command git -ErrorAction SilentlyContinue)) { return $false }
    if ((Run-Native { git -C $dir fetch --quiet }) -ne 0) { return $false }
    $here = (git -C $dir rev-parse HEAD 2>$null)
    $up = $null; foreach ($ref in @('@{u}', 'origin/HEAD', 'origin/main')) { $up = (git -C $dir rev-parse $ref 2>$null); if ($LASTEXITCODE -eq 0 -and $up) { break } }
    return ($here -and $here -eq $up)
}
$Current = (Test-Path -LiteralPath (Join-Path $St 'plugins\CCST\node_modules')) -and (Test-UpToDate (Join-Path $St 'plugins\CCST'))
if ($Current) {
    foreach ($d in @((Join-Path $St 'public\scripts\extensions\third-party\CCST')) + @(Get-ChildItem -Path (Join-Path $St 'data\*\extensions\CCST') -Directory -ErrorAction SilentlyContinue | ForEach-Object FullName)) {
        if ((Test-Path -LiteralPath (Join-Path $d '.git')) -and -not (Test-UpToDate $d)) { $Current = $false }
    }
}

# 酒馆正在运行：要更新就先关掉（换插件文件、移走旧插件时它不能占着），装完再打开
$StPort = 8000
try { $m = Select-String -LiteralPath (Join-Path $St 'config.yaml') -Pattern '^port:\s*(\d+)' | Select-Object -First 1; if ($m) { $StPort = [int]$m.Matches[0].Groups[1].Value } } catch { }
$StRunning = $false; $Stopped = $false
if ($env:CCST_NO_PROCESS_SCAN -ne '1') {
    $stPids = @()
    try {
        $stPids = @(Get-NetTCPConnection -LocalPort $StPort -State Listen -ErrorAction Stop | Select-Object -ExpandProperty OwningProcess -Unique | Where-Object {
            $p = Get-CimInstance Win32_Process -Filter "ProcessId=$_" -ErrorAction SilentlyContinue
            $p -and $p.Name -eq 'node.exe' -and $p.CommandLine -match 'server\.js'
        })
    } catch { }
    if ($stPids.Count -and $Current) {
        $StRunning = $true; Ok 'CCST 已经是最新版，酒馆不用关'
    } elseif ($stPids.Count) {
        $StRunning = $true
        $yes = $AssumeYes -or ((Read-Host '有新版本，要先关掉酒馆（聊天记录都已保存），装完在新窗口里重新打开。现在关？[Y/n]') -notmatch '^[nN]')
        if (-not $yes) { Warn '没关。装完要自己关掉酒馆再打开。' }
        else {
            foreach ($id in $stPids) { Stop-Process -Id $id -Force -ErrorAction SilentlyContinue }
            Start-Sleep -Seconds 2
            $StRunning = $false; $Stopped = $true; Ok '酒馆已关掉（它的黑窗口可以关掉了）'
        }
    }
}

# ── 2. Node.js ──
Step '2/6 检查 Node.js（代理靠它运行）'
$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCmd) {
    try { Start-Process 'https://nodejs.org/zh-cn/download' } catch { }
    Stop-With '这台电脑上没有 Node.js。' @('刚才已经帮你打开了 Node.js 官网：下载「LTS」版本的 Windows 安装包，一路点「Next」装好。', '装好以后，再双击一次「CCST安装.bat」就行。')
}
$nv = (& node -v).Trim()
if ([int]($nv.TrimStart('v').Split('.')[0]) -lt 18) {
    try { Start-Process 'https://nodejs.org/zh-cn/download' } catch { }
    Stop-With "Node.js 版本太旧（$nv），需要 18 或更高。" @('刚才已经帮你打开了 Node.js 官网：下载「LTS」版本装上，再双击一次「CCST安装.bat」。')
}
Ok "Node.js $nv"

# ── 3. 打开插件开关 ──
Step '3/6 打开酒馆的插件开关'
$Cfg = Join-Path $St 'config.yaml'
if (-not (Test-Path -LiteralPath $Cfg)) {
    $def = Join-Path $St 'default\config.yaml'
    if (Test-Path -LiteralPath $def) {
        try { Copy-Item -LiteralPath $def -Destination $Cfg } catch { Stop-With '没法创建 config.yaml' @('请检查酒馆文件夹有没有写入权限。') }
        Ok '酒馆还没生成设置文件，已按默认内容建了一个'
    } else {
        Stop-With '酒馆文件夹里没有 config.yaml。' @('先把酒馆启动一次（让它自己生成），关掉，再双击「CCST安装.bat」。')
    }
}
$utf8 = New-Object System.Text.UTF8Encoding($false)
$text = [IO.File]::ReadAllText($Cfg)
if ($text -match '(?m)^enableServerPlugins:[ \t]*true([ \t#\r]|$)') {
    Ok '插件开关本来就是开的'
} else {
    $bak = "$Cfg.ccst-backup-$Stamp"
    try { Copy-Item -LiteralPath $Cfg -Destination $bak } catch { Stop-With '备份 config.yaml 失败，没有改动任何东西。' @('请检查酒馆文件夹有没有写入权限。') }
    if ($text -match '(?m)^enableServerPlugins:') {
        $new = [regex]::Replace($text, '(?m)^enableServerPlugins:[ \t]*[A-Za-z]+', 'enableServerPlugins: true')
    } else {
        $nl = if ($text.Contains("`r`n")) { "`r`n" } else { "`n" }
        $new = $text
        if ($new.Length -gt 0 -and -not $new.EndsWith("`n")) { $new += $nl }
        $new += "enableServerPlugins: true$nl"
    }
    [IO.File]::WriteAllText($Cfg, $new, $utf8)
    if ([IO.File]::ReadAllText($Cfg) -notmatch '(?m)^enableServerPlugins:[ \t]*true') {
        Stop-With '改设置文件没成功。' @("备份在 $bak ，原文件没有损坏。", '手动改：用记事本打开 config.yaml，把 enableServerPlugins 那一行改成 true。')
    }
    Ok "已打开（只改了这一行，原文件备份在 config.yaml.ccst-backup-$Stamp）"
}

# ── 4. 装 CCST ──
Step '4/6 下载并安装 CCST'
$Dest = Join-Path $St 'plugins\CCST'
try { New-Item -ItemType Directory -Force -Path (Join-Path $St 'plugins') | Out-Null } catch { Stop-With '没法创建 plugins 文件夹。' @('请检查酒馆文件夹有没有写入权限。') }
$haveGit = [bool](Get-Command git -ErrorAction SilentlyContinue)
function Install-Zip {
    $tmp = Join-Path ([IO.Path]::GetTempPath()) ("ccst-" + [guid]::NewGuid().ToString('N'))
    try {
        New-Item -ItemType Directory -Force -Path $tmp | Out-Null
        Say '  正在下载…'
        $zip = Join-Path $tmp 'ccst.zip'
        if ($ZipUrl -like 'file:*') { Copy-Item -LiteralPath ([Uri]$ZipUrl).LocalPath -Destination $zip }  # 测试用
        else { Invoke-WebRequest -UseBasicParsing -Uri $ZipUrl -OutFile $zip }
        Expand-Archive -LiteralPath $zip -DestinationPath (Join-Path $tmp 'x') -Force
        $top = Get-ChildItem -LiteralPath (Join-Path $tmp 'x') -Directory | Select-Object -First 1
        if (-not $top -or -not (Test-Path -LiteralPath (Join-Path $top.FullName 'package.json'))) { return $false }
        New-Item -ItemType Directory -Force -Path $Dest | Out-Null
        # 更新：先清掉旧代码（新版删掉的文件不能留着），只留 data（聊天统计、设置）和 node_modules
        Get-ChildItem -LiteralPath $Dest -Force | Where-Object { @('data', 'node_modules') -notcontains $_.Name } | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
        Copy-Item -Path (Join-Path $top.FullName '*') -Destination $Dest -Recurse -Force
        return $true
    } catch { return $false } finally { Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue }
}
if (Test-Path -LiteralPath (Join-Path $Dest '.git')) {
    Say '  已经装过，检查更新…'
    if ($haveGit -and ((Run-Native { git -C $Dest pull --ff-only --quiet }) -eq 0)) { Ok '已更新到最新' }
    else { Warn '没能自动更新（可能你改过里面的文件，或者没联网）。继续使用现在这个版本。' }
} elseif (Test-Path -LiteralPath (Join-Path $Dest 'package.json')) {
    Say '  已经装过（下载版），更新文件…'
    if (Install-Zip) { Ok '已更新到最新' } else { Warn '没能更新（没联网？）。继续使用现在这个版本。' }
} elseif ((Test-Path -LiteralPath $Dest) -and (Get-ChildItem -LiteralPath $Dest -Force | Select-Object -First 1)) {
    Stop-With 'plugins\CCST 已经存在，但里面不像是 CCST。' @('为了不弄坏你的东西，没有动它。把它改个名字（比如 CCST-旧）再双击「CCST安装.bat」。')
} else {
    $done = $false
    if ($haveGit) {
        Say '  正在下载…'
        if ((Run-Native { if ($Branch) { git clone --quiet --branch $Branch $RepoUrl $Dest } else { git clone --quiet $RepoUrl $Dest } }) -eq 0) { $done = $true }
        else { Warn '用 git 下载失败，换个办法再试'; Remove-Item -LiteralPath $Dest -Recurse -Force -ErrorAction SilentlyContinue }
    }
    if (-not $done) { $done = Install-Zip }
    if (-not $done) { Stop-With '下载 CCST 失败。' @('多半是没联网，或者访问 GitHub 很慢。检查网络（需要能打开 github.com），然后再双击「CCST安装.bat」。') }
    Ok "已下载到 $Dest"
}
if (-not (Test-Path -LiteralPath (Join-Path $Dest 'package.json'))) {
    Stop-With 'CCST 没装完整（缺少 package.json）。' @('再双击一次「CCST安装.bat」试试。')
}
# 面板：在酒馆里「安装扩展」装的是 git 版，酒馆不会自己更新它
$panels = @(Join-Path $St 'public\scripts\extensions\third-party\CCST') + @(Get-ChildItem -Path (Join-Path $St 'data\*\extensions\CCST') -Directory -ErrorAction SilentlyContinue | ForEach-Object { $_.FullName })
foreach ($p in $panels) {
    if (-not (Test-Path -LiteralPath (Join-Path $p '.git'))) { continue }
    if ($haveGit -and ((Run-Native { git -C $p pull --ff-only --quiet }) -eq 0)) { Ok '面板已更新' }
    else { Warn '面板没能自动更新：在酒馆 扩展 → 管理扩展 里点 CCST 的「更新」。' }
}
# 旧版本留下的东西：别的文件夹里的旧插件 / 旧面板（会抢 8901 端口，聊天还是走旧代码）、指向别处的旧开机自启
$old = New-Object System.Collections.Generic.List[string]
foreach ($d in @(Get-ChildItem -LiteralPath (Join-Path $St 'plugins') -Directory -ErrorAction SilentlyContinue | Where-Object { $_.Name -ne 'CCST' } | ForEach-Object { $_.FullName })) {
    $files = @(Get-ChildItem -LiteralPath $d -File -Filter '*.js' -ErrorAction SilentlyContinue | ForEach-Object { $_.FullName })
    $files += @((Join-Path $d 'package.json'), (Join-Path $d 'src\proxy\plugin.js')) | Where-Object { Test-Path -LiteralPath $_ }
    if ($files.Count -and (Select-String -LiteralPath $files -Pattern 'claude-subscription' -SimpleMatch -Quiet)) { $old.Add($d) }
}
foreach ($n in @('SillyTavern-ClaudeMax', 'SillyTavern-ClaudeSubscription')) {
    $x = Join-Path $St "public\scripts\extensions\third-party\$n"; if (Test-Path -LiteralPath $x) { $old.Add($x) }
    Get-ChildItem -Path (Join-Path $St "data\*\extensions\$n") -Directory -ErrorAction SilentlyContinue | ForEach-Object { $old.Add($_.FullName) }
}
$startup = [Environment]::GetFolderPath('Startup')
try {
    $sh = New-Object -ComObject WScript.Shell
    Get-ChildItem -LiteralPath $startup -Filter '*.lnk' -ErrorAction SilentlyContinue | ForEach-Object {
        $a = $sh.CreateShortcut($_.FullName).Arguments
        if ($a -match 'claude-max\.ps1' -and -not $a.Contains($Dest)) { $old.Add($_.FullName) }
    }
} catch { }
if ($old.Count) {
    Say '  找到旧版本留下的东西：'
    foreach ($o in $old) { Say "    $o" }
    $yes = $AssumeYes -or ((Read-Host '  移到备份文件夹（不删除）？[Y/n]') -notmatch '^[nN]')
    if (-not $yes) { Warn '没动它们。它们还在的话，聊天可能还是走旧版本。' }
    else {
        $bak = Join-Path $St "CCST旧版备份-$Stamp"
        New-Item -ItemType Directory -Force -Path $bak | Out-Null
        foreach ($o in $old) {
            $name = "{0}-{1}" -f (Split-Path (Split-Path $o -Parent) -Leaf), (Split-Path $o -Leaf)
            try { Move-Item -LiteralPath $o -Destination (Join-Path $bak $name) -ErrorAction Stop; Ok "已移走 $(Split-Path $o -Leaf)" }
            catch { Warn "移不走 $o（可能正在运行）：关掉酒馆后再运行一次安装。" }
        }
        Ok "备份在 $bak（用了几天没问题就可以删）"
    }
}
# 正在运行的代理不是这一份（旧版本、别的文件夹）：装完要先关掉它
if ($env:CCST_NO_PROCESS_SCAN -ne '1') {
    try {
        $r = Invoke-RestMethod -UseBasicParsing -Uri 'http://127.0.0.1:8901/status' -TimeoutSec 3
        if ($r.plugin -eq 'claude-subscription' -and $r.root -ne $Dest) {
            $where = if ($r.root) { "（$($r.root)）" } else { '' }
            Warn "现在 8901 上在跑 CCST v$($r.version)$where。下面装完后，先关掉所有酒馆窗口，再启动酒馆。"
        }
    } catch { }
}

# ── 5. 依赖 ──
Step '5/6 安装依赖（第一次要联网下载，约 1–3 分钟）'
Push-Location $Dest
try {
    $rc = Run-Native { npm install --no-audit --no-fund --loglevel=error }
    if ($rc -ne 0) {
        Stop-With '依赖没装成功。' @('先检查网络能不能上外网，再双击「CCST安装.bat」重试。', '如果窗口里提示 EPERM / 权限，右键「CCST安装.bat」选「以管理员身份运行」。')
    }
    Ok '依赖装好了'

    # 面板在酒馆里被停用了（扩展 → 管理扩展 里关掉的）：重新启用。酒馆开着时它会覆盖设置，只能让你自己开
    # 这一步可有可无：脚本不在或出错都不能让安装中断（PowerShell 5.1 会把 node 的报错输出当成异常）
    if (Test-Path 'installer/panel-enable.mjs') {
        try {
            $off = "$(node installer/panel-enable.mjs $St --check 2>$null)"
            if ($off.Trim()) {
                if ($StRunning) { Warn 'CCST 面板在酒馆里被停用了：在 扩展 → 管理扩展 里把 CCST 打开。' }
                else { node installer/panel-enable.mjs $St | Out-Null; Ok 'CCST 面板之前被停用了，已重新启用' }
            }
        } catch { }
    }

    # ── 6. 登录 Claude ──
    Step '6/6 登录 Claude'
    if ($env:CCST_SKIP_LOGIN -eq '1') {
        Warn '（测试：跳过登录）'
    } else {
        $old = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
        $status = "$(node bin/claude-cli.js auth status 2>$null)"
        $ErrorActionPreference = $old
        if ($status -match '"loggedIn"\s*:\s*true') {
            Ok '已经登录过 Claude，不用再登了'
        } else {
            Say '马上会打开浏览器，用你的 Claude 账号（Pro 或 Max）登录并点「授权」。'
            if ((Run-Native { npm run login --silent }) -eq 0) { Ok '登录成功' }
            else {
                Warn '登录没完成，不影响安装。之后补登：再双击一次「CCST安装.bat」，它会重新打开登录。'
            }
        }
    }
} finally { Pop-Location }

Write-Host ''
Write-Host '════════════════════════════════'
$reopened = $false
if ($Stopped) { try { Start-Process -FilePath (Join-Path $St 'Start.bat') -WorkingDirectory $St; $reopened = $true } catch { } }
if ($reopened) {
    Write-Host '装好了。酒馆已经在新弹出的黑窗口里运行：' -ForegroundColor Green
    Write-Host '  · 那个窗口就是酒馆，聊天时一直开着，关掉它酒馆和 CCST 就都停了。'
    Write-Host '  · 现在这个窗口可以关了。'
    Write-Host '  · 浏览器里按 Ctrl+F5 刷新酒馆页面。'
} elseif ($Current -and $StRunning) {
    Write-Host '已经是最新版，酒馆照常用，不用重启。' -ForegroundColor Green
} else {
    Write-Host '装好了。关掉酒馆再打开，面板会自动连上。' -ForegroundColor Green
    Write-Host '（酒馆的黑窗口关掉再重新启动；浏览器里按 Ctrl+F5 刷新一下。）'
}
Finish 0
