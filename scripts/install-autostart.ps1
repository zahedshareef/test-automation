<#
.SYNOPSIS
  Starts the QA automation tool automatically when the current tester signs in to Windows,
  and adds a Start menu shortcut that opens the UI.

.DESCRIPTION
  This uses a per-user logon scheduled task, not a Windows service, on purpose:
   - A service runs in session 0 under a service account. It cannot show a browser for
     headed runs, and it cannot read the tester's Windows Credential Manager entries,
     where the Jira, Octopus and GitHub tokens and the test account password are stored.
   - Running as the tester keeps secrets in that tester's own credential store, and the
     server only listens on 127.0.0.1.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\install-autostart.ps1
  powershell -ExecutionPolicy Bypass -File scripts\install-autostart.ps1 -Uninstall
#>
param([switch]$Uninstall, [int]$Port = 4870)

$ErrorActionPreference = 'Stop'
$TaskName = 'QA Automation Tool'
$Root = Split-Path -Parent $PSScriptRoot
$Shortcut = Join-Path ([Environment]::GetFolderPath('Programs')) 'QA Automation.url'

if ($Uninstall) {
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
  Remove-Item $Shortcut -ErrorAction SilentlyContinue
  Write-Host 'Removed autostart task and shortcut.'
  return
}

$node = (Get-Command node -ErrorAction Stop).Source
$nodeVersion = [version](& $node -p "process.versions.node")
if ($nodeVersion -lt [version]'22.18.0') { throw "Node.js 22.18 or later is required (found $nodeVersion)." }

$action = New-ScheduledTaskAction -Execute $node -Argument '"src/server/index.ts"' -WorkingDirectory $Root
$trigger = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null
Set-Content -Path $Shortcut -Value "[InternetShortcut]`r`nURL=http://localhost:$Port/"
Start-ScheduledTask -TaskName $TaskName

Write-Host "Installed. The tool starts at sign-in and is running now at http://localhost:$Port/"
Write-Host "A 'QA Automation' shortcut was added to the Start menu."
