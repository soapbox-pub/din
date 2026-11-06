# Din as this user's Windows shell, in place of explorer.exe, from the next
# sign-in. Written by Din's scripts/windows-shell.mjs, beside din.exe.
#
#   .\install-shell.ps1            log in to Din
#   .\install-shell.ps1 -Restore   log in to Explorer again
#
# Ctrl+Alt+Del -> Task Manager -> Run new task -> explorer.exe gets Explorer
# back for one session if Din won't start.
param([switch]$Restore)

$key = 'HKCU:\Software\Microsoft\Windows NT\CurrentVersion\Winlogon'
if ($Restore) {
  Remove-ItemProperty -Path $key -Name Shell -ErrorAction SilentlyContinue
  Write-Output 'Explorer is your shell again from the next sign-in.'
  exit 0
}

$din = Join-Path $PSScriptRoot 'din.exe'
if (-not (Test-Path $din)) { throw "din.exe isn't beside this script" }
New-Item -Path $key -Force | Out-Null
Set-ItemProperty -Path $key -Name Shell -Value "`"$din`" --din-shell"
Write-Output "Din is your shell from the next sign-in ($din)."
