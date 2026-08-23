$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$vswhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
$msbuildPath = & $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -find MSBuild\**\Bin\MSBuild.exe | Select-Object -First 1
if (-not $msbuildPath) { throw 'Visual Studio MSBuild with the C++ x64 tools was not found.' }

$kitRoot = "${env:ProgramFiles(x86)}\Windows Kits\10"
$offregHeader = Get-ChildItem "$kitRoot\Include" -Recurse -Filter offreg.h | Sort-Object FullName -Descending | Select-Object -First 1
$offregLibrary = Get-ChildItem "$kitRoot\Lib" -Recurse -Filter offreg.lib | Where-Object FullName -Match '\\x64\\' | Sort-Object FullName -Descending | Select-Object -First 1
$offregDll = Get-ChildItem "$kitRoot\Redist" -Recurse -Filter offreg.dll | Where-Object FullName -Match '\\x64\\' | Sort-Object FullName -Descending | Select-Object -First 1
if (-not $offregHeader -or -not $offregLibrary -or -not $offregDll) { throw 'WDK Offline Registry headers, x64 library, or redistributable were not found.' }

$sdkVersion = $offregHeader.Directory.Parent.Name
$projectDir = Join-Path $root 'native\vscode-reg-native'
$project = Join-Path $projectDir 'vscode-reg-native.vcxproj'
$out = Join-Path $root 'native\bin\win32-x64'
& $msbuildPath $project -restore -m -p:Configuration=Release -p:Platform=x64 -p:WindowsTargetPlatformVersion=$sdkVersion
if ($LASTEXITCODE) { throw "Native build failed with exit code $LASTEXITCODE." }
New-Item $out -ItemType Directory -Force | Out-Null
$targetExecutable = Join-Path $out 'vscode-reg-native.exe'
Get-CimInstance Win32_Process -Filter "Name = 'vscode-reg-native.exe'" |
    Where-Object { $_.ExecutablePath -eq $targetExecutable } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
Copy-Item (Join-Path $projectDir 'build\x64\Release\vscode-reg-native.exe') $out -Force
Copy-Item $offregDll.FullName $out -Force
Write-Host "Built $out"
