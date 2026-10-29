$ErrorActionPreference = 'Stop'

$logPath = Join-Path $PSScriptRoot 'configure-video-pagefile.log'
"[$(Get-Date -Format o)] Starting pagefile configuration." | Set-Content -LiteralPath $logPath

try {
    $computer = Get-CimInstance -ClassName Win32_ComputerSystem
    Set-CimInstance -InputObject $computer -Property @{ AutomaticManagedPagefile = $false } | Out-Null

$targetName = 'D:\pagefile.sys'
$existing = Get-CimInstance -ClassName Win32_PageFileSetting -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -ieq $targetName }

if ($existing) {
    Set-CimInstance -InputObject $existing -Property @{
        InitialSize = [uint32]32768
        MaximumSize = [uint32]49152
    } | Out-Null
} else {
    New-CimInstance -ClassName Win32_PageFileSetting -Property @{
        Name = $targetName
        InitialSize = [uint32]32768
        MaximumSize = [uint32]49152
    } | Out-Null
}

    $settings = Get-CimInstance -ClassName Win32_PageFileSetting |
        Select-Object Name, InitialSize, MaximumSize
    $settings | Format-Table -AutoSize | Out-String | Add-Content -LiteralPath $logPath
    "[$(Get-Date -Format o)] Configuration saved. Windows restart required." | Add-Content -LiteralPath $logPath
} catch {
    "[$(Get-Date -Format o)] ERROR: $($_.Exception.Message)" | Add-Content -LiteralPath $logPath
    $_ | Format-List * -Force | Out-String | Add-Content -LiteralPath $logPath
    exit 1
}
