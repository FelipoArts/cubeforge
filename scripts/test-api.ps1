# Teste da API Central do CubeForge
# Uso: .\scripts\test-api.ps1 [-ApiUrl "http://localhost:8787"]
# Por padrão, testa contra a API de produção

param(
    [string]$ApiUrl = "https://api.cubeforge.dev"
)

$ErrorActionPreference = "Stop"

Write-Host "=== Teste da API Central do CubeForge ===" -ForegroundColor Cyan
Write-Host "API URL: $ApiUrl" -ForegroundColor Gray
Write-Host ""

# 1. Health Check
Write-Host "1. Health Check..." -ForegroundColor Yellow
try {
    $health = Invoke-RestMethod -Uri "$ApiUrl/health" -Method Get
    Write-Host "   OK: $($health | ConvertTo-Json)" -ForegroundColor Green
} catch {
    Write-Host "   ERRO: $_" -ForegroundColor Red
    exit 1
}

# 2. Registrar servidor
Write-Host "2. Registrando servidor de teste..." -ForegroundColor Yellow
$registerBody = @{
    name = "Servidor de Teste"
    version = "1.21.1"
    serverType = "vanilla"
    description = "Servidor criado pelo script de teste"
    status = "starting"
    port = 25565
    maxPlayers = 20
    networkProvider = @{
        provider = "tailscale"
        connectionInfo = @{
            hostIp = "100.80.23.89"
            hostname = "cubeforge-dev"
        }
    }
} | ConvertTo-Json

try {
    $registerResult = Invoke-RestMethod -Uri "$ApiUrl/api/servers" -Method Post -Body $registerBody -ContentType "application/json"
    Write-Host "   OK: $($registerResult | ConvertTo-Json)" -ForegroundColor Green
    $shortCode = $registerResult.shortCode
} catch {
    Write-Host "   ERRO: $_" -ForegroundColor Red
    exit 1
}

# 3. Descobrir servidor (antes de ficar online)
Write-Host "3. Descobrindo servidor (status=starting)..." -ForegroundColor Yellow
try {
    $discoverResult = Invoke-RestMethod -Uri "$ApiUrl/api/servers/$shortCode" -Method Get
    Write-Host "   OK: $($discoverResult | ConvertTo-Json)" -ForegroundColor Green
    
    if ($discoverResult.status -ne "starting") {
        Write-Host "   AVISO: Status esperado 'starting', obtido '$($discoverResult.status)'" -ForegroundColor Yellow
    }
} catch {
    Write-Host "   ERRO: $_" -ForegroundColor Red
    exit 1
}

# 4. Atualizar status para online
Write-Host "4. Atualizando status para 'online'..." -ForegroundColor Yellow
$statusBody = @{ status = "online" } | ConvertTo-Json
try {
    $statusResult = Invoke-RestMethod -Uri "$ApiUrl/api/servers/$shortCode/status" -Method Patch -Body $statusBody -ContentType "application/json"
    Write-Host "   OK: $($statusResult | ConvertTo-Json)" -ForegroundColor Green
} catch {
    Write-Host "   ERRO: $_" -ForegroundColor Red
    exit 1
}

# 5. Descobrir servidor novamente (agora online)
Write-Host "5. Descobrindo servidor novamente (status=online)..." -ForegroundColor Yellow
try {
    $discoverResult2 = Invoke-RestMethod -Uri "$ApiUrl/api/servers/$shortCode" -Method Get
    Write-Host "   OK: $($discoverResult2 | ConvertTo-Json)" -ForegroundColor Green
    
    if ($discoverResult2.status -ne "online") {
        Write-Host "   AVISO: Status esperado 'online', obtido '$($discoverResult2.status)'" -ForegroundColor Yellow
    }
    
    # Verificar campos importantes
    if (-not $discoverResult2.networkProvider) {
        Write-Host "   AVISO: networkProvider não retornado!" -ForegroundColor Yellow
    }
    if (-not $discoverResult2.hostIp -and -not $discoverResult2.networkProvider.connectionInfo.hostIp) {
        Write-Host "   AVISO: hostIp não encontrado no response!" -ForegroundColor Yellow
    }
} catch {
    Write-Host "   ERRO: $_" -ForegroundColor Red
    exit 1
}

# 6. Heartbeat
Write-Host "6. Enviando heartbeat..." -ForegroundColor Yellow
$heartbeatBody = @{ status = "online"; currentPlayers = 3 } | ConvertTo-Json
try {
    $heartbeatResult = Invoke-RestMethod -Uri "$ApiUrl/api/servers/$shortCode/heartbeat" -Method Post -Body $heartbeatBody -ContentType "application/json"
    Write-Host "   OK: $($heartbeatResult | ConvertTo-Json)" -ForegroundColor Green
} catch {
    Write-Host "   ERRO: $_" -ForegroundColor Red
    exit 1
}

# 7. Remover servidor
Write-Host "7. Removendo servidor..." -ForegroundColor Yellow
try {
    $deleteResult = Invoke-RestMethod -Uri "$ApiUrl/api/servers/$shortCode" -Method Delete
    Write-Host "   OK: $($deleteResult | ConvertTo-Json)" -ForegroundColor Green
} catch {
    Write-Host "   ERRO: $_" -ForegroundColor Red
    exit 1
}

# 8. Verificar que servidor foi removido
Write-Host "8. Verificando remoção (deve retornar 404)..." -ForegroundColor Yellow
try {
    $discoverResult3 = Invoke-RestMethod -Uri "$ApiUrl/api/servers/$shortCode" -Method Get
    Write-Host "   AVISO: Servidor ainda existe! $($discoverResult3 | ConvertTo-Json)" -ForegroundColor Yellow
} catch {
    Write-Host "   OK: Servidor removido (HTTP $($_.Exception.Response.StatusCode.value__))" -ForegroundColor Green
}

Write-Host ""
Write-Host "=== Teste concluído! ===" -ForegroundColor Cyan
