# Runs the API against a local MongoDB in a podman container (quiz-mongo) on http://localhost:7071.
# Usage: pwsh -NoProfile -File Server/run-server-podman.ps1
# Real env vars win over .env, so MONGODB_URI here overrides the Atlas one in .env.
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

$name = 'quiz-mongo'
$state = podman inspect -f '{{.State.Running}}' $name 2>$null
if ($LASTEXITCODE -ne 0) {
    podman run -d --name $name -p 27017:27017 -v quiz-mongo-data:/data/db mongo:8 | Out-Null
} elseif ($state -ne 'true') {
    podman start $name | Out-Null
}

# Whether something accepts connections on host:27017 within a second.
function Test-Mongo([string]$hostName) {
    $client = [Net.Sockets.TcpClient]::new()
    try {
        return $client.ConnectAsync($hostName, 27017).Wait(1000) -and $client.Connected
    } catch {
        return $false
    } finally {
        $client.Dispose()
    }
}

# The Podman machine's own IPv4 address (a WSL2 VM, which Windows reaches directly); empty when it cannot be read.
function Get-MachineAddress {
    $machine = podman machine inspect --format '{{.Name}}' 2>$null
    if ($LASTEXITCODE -ne 0 -or -not $machine) { return '' }
    $line = wsl -d $machine -- ip -4 -o addr show eth0 2>$null
    if ($line -match 'inet (\d+\.\d+\.\d+\.\d+)') { return $Matches[1] }
    return ''
}

# 127.0.0.1, not localhost: localhost resolves to ::1 first, where Podman's forwarding may accept a connection and
# drop it. When the forwarding to Windows does not answer at all, the container is reached on the machine's address.
# A container started just now takes a few seconds to listen.
$mongoHost = ''
$machineAddress = $null
for ($try = 0; $try -lt 10 -and -not $mongoHost; $try++) {
    if (Test-Mongo '127.0.0.1') {
        $mongoHost = '127.0.0.1'
        break
    }
    if ($null -eq $machineAddress) { $machineAddress = Get-MachineAddress }
    if ($machineAddress -and (Test-Mongo $machineAddress)) {
        $mongoHost = $machineAddress
        break
    }
    Start-Sleep -Seconds 1
}
if (-not $mongoHost) {
    Write-Error "MongoDB ($name) does not answer on 127.0.0.1:27017 nor on the Podman machine's address ('$machineAddress'). Check 'podman ps' and 'podman machine list'."
}
Write-Host "MongoDB at ${mongoHost}:27017"

$env:MONGODB_URI = "mongodb://${mongoHost}:27017"
$env:PORT = '7071'
go run ./cmd/server
exit $LASTEXITCODE
