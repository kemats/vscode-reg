param(
    [Parameter(Mandatory = $true)]
    [string]$OutputPath,

    [Parameter(Mandatory = $true)]
    [string]$OffregDirectory
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class NativeMethods
{
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern bool SetDllDirectory(string path);

    [DllImport("offreg.dll")]
    public static extern uint ORCreateHive(out IntPtr hive);

    [DllImport("offreg.dll")]
    public static extern uint ORCloseHive(IntPtr hive);

    [DllImport("offreg.dll", CharSet = CharSet.Unicode)]
    public static extern uint ORSaveHive(IntPtr hive, string path, uint osMajorVersion, uint osMinorVersion);

    [DllImport("offreg.dll", CharSet = CharSet.Unicode)]
    public static extern uint ORCreateKey(
        IntPtr key,
        string subKey,
        string keyClass,
        uint options,
        IntPtr securityDescriptor,
        out IntPtr result,
        out uint disposition);

    [DllImport("offreg.dll")]
    public static extern uint ORCloseKey(IntPtr key);

    [DllImport("offreg.dll", CharSet = CharSet.Unicode)]
    public static extern uint ORSetValue(IntPtr key, string valueName, uint type, byte[] data, uint dataSize);
}
'@

function Assert-Success([uint32]$Status, [string]$Operation) {
    if ($Status -ne 0) {
        throw "$Operation failed with Win32 error $Status."
    }
}

if (-not [NativeMethods]::SetDllDirectory($OffregDirectory)) {
    throw "Could not add the Offline Registry runtime directory: $OffregDirectory"
}

$hive = [IntPtr]::Zero
$child = [IntPtr]::Zero
try {
    Remove-Item $OutputPath -Force -ErrorAction SilentlyContinue
    Assert-Success ([NativeMethods]::ORCreateHive([ref]$hive)) 'ORCreateHive'

    $text = [Text.Encoding]::Unicode.GetBytes("NeedleValue`0")
    Assert-Success ([NativeMethods]::ORSetValue($hive, 'Text', 1, $text, $text.Length)) 'ORSetValue(Text)'

    $count = [BitConverter]::GetBytes([uint32]42)
    Assert-Success ([NativeMethods]::ORSetValue($hive, 'Count', 4, $count, $count.Length)) 'ORSetValue(Count)'

    [byte[]]$blob = 0, 1, 127, 128, 255
    Assert-Success ([NativeMethods]::ORSetValue($hive, 'Blob', 3, $blob, $blob.Length)) 'ORSetValue(Blob)'

    [uint32]$disposition = 0
    Assert-Success ([NativeMethods]::ORCreateKey($hive, 'Child', $null, 0, [IntPtr]::Zero, [ref]$child, [ref]$disposition)) 'ORCreateKey(Child)'
    $enabled = [BitConverter]::GetBytes([uint32]1)
    Assert-Success ([NativeMethods]::ORSetValue($child, 'Enabled', 4, $enabled, $enabled.Length)) 'ORSetValue(Enabled)'
    Assert-Success ([NativeMethods]::ORCloseKey($child)) 'ORCloseKey'
    $child = [IntPtr]::Zero

    Assert-Success ([NativeMethods]::ORSaveHive($hive, $OutputPath, 10, 0)) 'ORSaveHive'
}
finally {
    if ($child -ne [IntPtr]::Zero) { [void][NativeMethods]::ORCloseKey($child) }
    if ($hive -ne [IntPtr]::Zero) { [void][NativeMethods]::ORCloseHive($hive) }
    [void][NativeMethods]::SetDllDirectory($null)
}