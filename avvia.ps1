# ================================================
#   AvatarGenGioIA - Avvio Server + ngrok
#   Uso: .\avvia.ps1   oppure doppio click su avvia.bat
# ================================================

$ROOT  = Split-Path -Parent $MyInvocation.MyCommand.Definition
$NGROK = "C:\Users\Admin\AppData\Local\Microsoft\WinGet\Links\ngrok.exe"
$PORT  = 3333

# Ferma processi esistenti
Get-Process node,ngrok -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep 1

Write-Host ""
Write-Host "  AvatarGenGioIA - Avvio..." -ForegroundColor Cyan

# Finestra 1: Node server (con riavvio automatico)
Start-Process powershell -ArgumentList "-NoExit", "-ExecutionPolicy", "Bypass", "-Command",
    "Set-Location '$ROOT'; `$host.UI.RawUI.WindowTitle = 'AvatarGenGioIA - Server'; while(`$true){ node server.js; Write-Host 'Riavvio in 3s...' -ForegroundColor Yellow; Start-Sleep 3 }"

# Attendi che il server sia pronto
Write-Host "  Attendo Node server..." -ForegroundColor Yellow
$ok = $false
for ($i = 0; $i -lt 15; $i++) {
    Start-Sleep 1
    try { $null = Invoke-WebRequest "http://localhost:$PORT" -UseBasicParsing -TimeoutSec 1 -ErrorAction Stop; $ok = $true; break } catch {}
}
if (-not $ok) { Write-Host "  ERRORE: server non risponde" -ForegroundColor Red; exit 1 }
Write-Host "  Node OK --> http://localhost:$PORT" -ForegroundColor Green

# Finestra 2: ngrok (con riavvio automatico)
Start-Process powershell -ArgumentList "-NoExit", "-ExecutionPolicy", "Bypass", "-Command",
    "`$host.UI.RawUI.WindowTitle = 'AvatarGenGioIA - ngrok'; while(`$true){ & '$NGROK' http $PORT; Write-Host 'Riavvio ngrok in 5s...' -ForegroundColor Yellow; Start-Sleep 5 }"

# Attendi URL ngrok
Write-Host "  Attendo ngrok..." -ForegroundColor Yellow
$url = $null
for ($i = 0; $i -lt 20; $i++) {
    Start-Sleep 1
    try { $url = (Invoke-RestMethod "http://localhost:4040/api/tunnels" -ErrorAction Stop).tunnels[0].public_url; if ($url) { break } } catch {}
}

Write-Host ""
if ($url) {
    Write-Host "  *** URL PUBBLICO ***" -ForegroundColor Green
    Write-Host "  $url" -ForegroundColor White
} else {
    Write-Host "  ATTENZIONE: URL ngrok non ottenuto" -ForegroundColor Red
}
Write-Host ""
Write-Host "  Due finestre aperte: Server + ngrok"
Write-Host "  Chiudile per fermare tutto."
Write-Host ""
if ([Environment]::UserInteractive) {
    Read-Host "  Premi INVIO per chiudere questa finestra"
} else {
    while ($true) { Start-Sleep 60 }
}
