$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$vswhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
$msbuildPath = & $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -find MSBuild\**\Bin\MSBuild.exe | Select-Object -First 1
if (-not $msbuildPath) { throw 'Visual Studio MSBuild with the C++ x64 tools was not found.' }

$project = Join-Path $root 'test\native\whereCompilerTests.vcxproj'
& $msbuildPath $project -m -p:Configuration=Release -p:Platform=x64
if ($LASTEXITCODE) { throw "Native test build failed with exit code $LASTEXITCODE." }

$executable = Join-Path $root 'test\native\build\x64\Release\whereCompilerTests.exe'
& $executable
if ($LASTEXITCODE) { throw "Native tests failed with exit code $LASTEXITCODE." }