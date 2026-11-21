# Tiny static web server for Plantifi.ai. No installs, no admin rights needed.
# Serves http://localhost:PORT/ for this PC and http://<LAN-IP>:PORT/ so a phone on the same Wi-Fi can open it.
param([int]$Port = 8080, [switch]$NoBrowser)
$root = $PSScriptRoot

$lan = @(Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
  Where-Object { $_.IPAddress -notmatch '^(127\.|169\.254\.)' -and $_.InterfaceAlias -notmatch 'vEthernet|VirtualBox|VMware|Loopback|WSL' } |
  ForEach-Object { "http://$($_.IPAddress):$Port/" })

$listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Any, $Port)
try { $listener.Start() } catch { Write-Host "Could not start on port $Port (in use?). Try: .\start.ps1 -Port 8090"; exit 1 }

Write-Host ""
Write-Host "  Plantifi.ai is running" -ForegroundColor Green
Write-Host "  This PC : http://localhost:$Port/"
foreach ($u in $lan) { Write-Host "  Phone   : $u   (same Wi-Fi)" -ForegroundColor Cyan }
Write-Host "  Allow 'powershell' in Windows Firewall if prompted so your phone can connect. Ctrl+C to stop."
Write-Host ""
if (-not $NoBrowser) { Start-Process "http://localhost:$Port/" }

# One runspace per connection so idle browser sockets never block the server.
$handler = {
  param($client, $root, $lanJson)
  $mime = @{ ".html"="text/html; charset=utf-8"; ".css"="text/css"; ".js"="text/javascript"; ".json"="application/json"; ".svg"="image/svg+xml"; ".png"="image/png"; ".jpg"="image/jpeg"; ".jpeg"="image/jpeg"; ".ico"="image/x-icon"; ".txt"="text/plain" }
  try {
    $client.ReceiveTimeout = 5000; $client.SendTimeout = 15000
    $s = $client.GetStream()
    $buf = New-Object byte[] 8192; $head = ""
    while ($head -notmatch "`r`n`r`n") { $n = $s.Read($buf, 0, $buf.Length); if ($n -le 0) { return }; $head += [Text.Encoding]::ASCII.GetString($buf, 0, $n); if ($head.Length -gt 32768) { return } }
    $parts = ($head -split "`r`n")[0] -split " "
    if ($parts.Count -lt 2 -or $parts[0] -ne "GET" -and $parts[0] -ne "HEAD") { $body = [Text.Encoding]::UTF8.GetBytes("Method not allowed"); $code = "405 Method Not Allowed"; $type = "text/plain" }
    else {
      $path = [Uri]::UnescapeDataString(($parts[1] -split "\?")[0].TrimStart("/"))
      if ($path -eq "") { $path = "index.html" }
      if ($path -eq "__info") { $code = "200 OK"; $type = "application/json"; $body = [Text.Encoding]::UTF8.GetBytes($lanJson) }
      else {
        $file = [IO.Path]::GetFullPath((Join-Path $root $path))
        if ($file.StartsWith($root) -and (Test-Path $file -PathType Leaf)) {
          $code = "200 OK"; $body = [IO.File]::ReadAllBytes($file); $ext = [IO.Path]::GetExtension($file).ToLower()
          $type = if ($mime.ContainsKey($ext)) { $mime[$ext] } else { "application/octet-stream" }
        } else { $code = "404 Not Found"; $type = "text/plain"; $body = [Text.Encoding]::UTF8.GetBytes("Not found") }
      }
    }
    $hdr = "HTTP/1.1 $code`r`nContent-Type: $type`r`nContent-Length: $($body.Length)`r`nCache-Control: no-cache`r`nConnection: close`r`n`r`n"
    $hb = [Text.Encoding]::ASCII.GetBytes($hdr)
    $s.Write($hb, 0, $hb.Length)
    if ($parts[0] -ne "HEAD") { $s.Write($body, 0, $body.Length) }
    $s.Flush()
  } catch {} finally { try { $client.Close() } catch {} }
}

$lanJson = (@{ urls = $lan } | ConvertTo-Json -Compress)
$pool = [runspacefactory]::CreateRunspacePool(1, 12); $pool.Open()
while ($true) {
  $client = $listener.AcceptTcpClient()
  $ps = [powershell]::Create(); $ps.RunspacePool = $pool
  [void]$ps.AddScript($handler).AddArgument($client).AddArgument($root).AddArgument($lanJson)
  [void]$ps.BeginInvoke()
}
