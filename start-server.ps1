$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$port = 8765

function Get-ContentType([string]$path) {
    switch ([IO.Path]::GetExtension($path).ToLowerInvariant()) {
        '.html' { 'text/html; charset=utf-8' }
        '.js' { 'application/javascript; charset=utf-8' }
        '.css' { 'text/css; charset=utf-8' }
        '.json' { 'application/json; charset=utf-8' }
        '.webmanifest' { 'application/manifest+json; charset=utf-8' }
        '.svg' { 'image/svg+xml' }
        '.png' { 'image/png' }
        '.jpg' { 'image/jpeg' }
        '.jpeg' { 'image/jpeg' }
        '.ico' { 'image/x-icon' }
        default { 'application/octet-stream' }
    }
}

$listener = [System.Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, $port)
$listener.Start()
$url = "http://127.0.0.1:$port/"
Start-Process $url
Write-Host "Kikitori Reader is running: $url"
Write-Host "Press Ctrl+C or close this window to stop."

try {
    while ($true) {
        $client = $listener.AcceptTcpClient()
        try {
            $stream = $client.GetStream()
            $reader = New-Object IO.StreamReader($stream, [Text.Encoding]::ASCII, $false, 4096, $true)
            $requestLine = $reader.ReadLine()
            if ([string]::IsNullOrWhiteSpace($requestLine)) { continue }
            while (($line = $reader.ReadLine()) -ne '') { if ($null -eq $line) { break } }

            $parts = $requestLine.Split(' ')
            $method = $parts[0]
            $rawPath = if ($parts.Length -gt 1) { $parts[1].Split('?')[0] } else { '/' }
            $relative = [Uri]::UnescapeDataString($rawPath).TrimStart('/')
            if ([string]::IsNullOrWhiteSpace($relative)) { $relative = 'index.html' }
            $relative = $relative.Replace('/', [IO.Path]::DirectorySeparatorChar)
            $fullPath = [IO.Path]::GetFullPath((Join-Path $root $relative))
            $rootFull = [IO.Path]::GetFullPath($root + [IO.Path]::DirectorySeparatorChar)

            if (-not $fullPath.StartsWith($rootFull, [StringComparison]::OrdinalIgnoreCase) -or -not (Test-Path $fullPath -PathType Leaf)) {
                $body = [Text.Encoding]::UTF8.GetBytes('404 Not Found')
                $header = "HTTP/1.1 404 Not Found`r`nContent-Type: text/plain; charset=utf-8`r`nContent-Length: $($body.Length)`r`nConnection: close`r`n`r`n"
            } else {
                $body = [IO.File]::ReadAllBytes($fullPath)
                $type = Get-ContentType $fullPath
                $header = "HTTP/1.1 200 OK`r`nContent-Type: $type`r`nContent-Length: $($body.Length)`r`nCache-Control: no-cache`r`nConnection: close`r`n`r`n"
            }
            $headerBytes = [Text.Encoding]::ASCII.GetBytes($header)
            $stream.Write($headerBytes, 0, $headerBytes.Length)
            if ($method -ne 'HEAD') { $stream.Write($body, 0, $body.Length) }
            $stream.Flush()
        } finally {
            $client.Close()
        }
    }
} finally {
    $listener.Stop()
}
