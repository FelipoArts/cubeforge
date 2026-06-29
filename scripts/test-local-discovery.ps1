# Script de Teste Local para Descoberta de Servidores
# 
# Testa o servidor HTTP de registro do Rust (127.0.0.1:25567)
# sem precisar de Tailscale ou dois computadores.
#
# Como usar:
#   1. Rode 'npm run tauri dev' (ou tenha o app rodando)
#   2. No host: inicie a rede mesh (mock ou tailscale)
#   3. O servidor HTTP de registro do Rust estará rodando em 127.0.0.1:25567
#   4. Execute este script: .\scripts\test-local-discovery.ps1
#
# Se o app não estiver rodando, este script inicia um servidor de teste
# que simula o comportamento do Rust registry.

param(
    [switch]$StartTestServer,
    [string]$ShortCode = "TESTE1"
)

Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  Teste Local de Descoberta de Servidor" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

$registryPort = 25567

if ($StartTestServer) {
    Write-Host "[INIT] Iniciando servidor de teste na porta $registryPort..." -ForegroundColor Yellow
    
    # Iniciar servidor HTTP de teste em background
    $testServer = Start-Job -ScriptBlock {
        param($port, $shortCode)
        
        # Criar um listener HTTP simples
        $listener = New-Object System.Net.HttpListener
        $listener.Prefixes.Add("http://127.0.0.1:$port/")
        $listener.Start()
        
        Write-Host "[Registry] Servidor HTTP iniciado em 127.0.0.1:$port"
        
        # Registrar servidor de teste
        $testEntry = @{
            short_code = $shortCode
            name = "Servidor de Teste Local"
            version = "1.20.1"
            server_type = "vanilla"
            description = "Servidor criado pelo script de teste"
            status = "online"
            port = 25565
        } | ConvertTo-Json
        
        $requestCount = 0
        
        while ($requestCount -lt 10) {
            $context = $listener.GetContext()
            $request = $context.Request
            $response = $context.Response
            
            $url = $request.Url.AbsolutePath + $request.Url.Query
            Write-Host "[Registry] $($request.HttpMethod) $url"
            
            $responseString = ""
            $statusCode = 200
            
            if ($url -like "/registry/resolve*") {
                $query = [System.Web.HttpUtility]::ParseQueryString($request.Url.Query)
                $code = $query["code"]
                Write-Host "[Registry] Resolvendo código: '$code'"
                
                if ($code -eq $shortCode) {
                    $responseString = $testEntry
                    Write-Host "[Registry] ✅ Servidor encontrado!" -ForegroundColor Green
                } else {
                    $statusCode = 404
                    $responseString = "{`"error`":`"Servidor não encontrado para o código: $code`"}"
                    Write-Host "[Registry] ❌ Código não encontrado: $code" -ForegroundColor Red
                }
            } elseif ($url -eq "/registry/list") {
                $responseString = "[$testEntry]"
            } elseif ($url -eq "/status") {
                $responseString = '{ "status": "ok" }'
            } else {
                $statusCode = 404
                $responseString = '{ "error": "Endpoint não encontrado" }'
            }
            
            $buffer = [System.Text.Encoding]::UTF8.GetBytes($responseString)
            $response.StatusCode = $statusCode
            $response.ContentType = "application/json"
            $response.Headers.Add("Access-Control-Allow-Origin", "*")
            $response.ContentLength64 = $buffer.Length
            $response.OutputStream.Write($buffer, 0, $buffer.Length)
            $response.OutputStream.Close()
            
            $requestCount++
        }
        
        $listener.Stop()
        Write-Host "[Registry] Servidor encerrado após $requestCount requisições."
    } -ArgumentList $registryPort, $ShortCode
    
    Start-Sleep -Seconds 2
    Write-Host "[INIT] Servidor de teste iniciado!" -ForegroundColor Green
    Write-Host ""
}

# Testar endpoints
Write-Host "=== Testando Endpoints ===" -ForegroundColor Yellow
Write-Host ""

$tests = @(
    @{ Name = "GET /status"; Url = "http://127.0.0.1:$registryPort/status"; ExpectedStatus = 200; ExpectedField = "status"; ExpectedValue = "ok" },
    @{ Name = "GET /registry/resolve?code=$ShortCode"; Url = "http://127.0.0.1:$registryPort/registry/resolve?code=$ShortCode"; ExpectedStatus = 200; ExpectedField = "short_code"; ExpectedValue = $ShortCode },
    @{ Name = "GET /registry/resolve?code=INVALIDO"; Url = "http://127.0.0.1:$registryPort/registry/resolve?code=INVALIDO"; ExpectedStatus = 404 },
    @{ Name = "GET /registry/list"; Url = "http://127.0.0.1:$registryPort/registry/list"; ExpectedStatus = 200 }
)

$allPassed = $true

foreach ($test in $tests) {
    Write-Host "  $($test.Name): " -NoNewline
    
    try {
        $response = Invoke-WebRequest -Uri $test.Url -TimeoutSec 5 -ErrorAction Stop
        
        if ($response.StatusCode -eq $test.ExpectedStatus) {
            $body = $response.Content | ConvertFrom-Json
            
            if ($test.ExpectedField) {
                $actualValue = $body.$($test.ExpectedField)
                if ($actualValue -eq $test.ExpectedValue) {
                    Write-Host "✅ OK" -ForegroundColor Green
                    Write-Host "     Resposta: $($response.Content)" -ForegroundColor Gray
                } else {
                    Write-Host "❌ FALHOU" -ForegroundColor Red
                    Write-Host "     Esperado: $($test.ExpectedField) = '$($test.ExpectedValue)'" -ForegroundColor Red
                    Write-Host "     Recebido: $($test.ExpectedField) = '$actualValue'" -ForegroundColor Red
                    $allPassed = $false
                }
            } else {
                Write-Host "✅ OK" -ForegroundColor Green
                Write-Host "     Resposta: $($response.Content)" -ForegroundColor Gray
            }
        } else {
            Write-Host "❌ FALHOU (Status: $($response.StatusCode), esperado: $($test.ExpectedStatus))" -ForegroundColor Red
            $allPassed = $false
        }
    } catch {
        if ($test.ExpectedStatus -eq 404 -and $_.Exception.Response.StatusCode -eq 404) {
            Write-Host "✅ OK (404 esperado)" -ForegroundColor Green
        } else {
            Write-Host "❌ FALHOU" -ForegroundColor Red
            Write-Host "     Erro: $_" -ForegroundColor Red
            $allPassed = $false
        }
    }
}

Write-Host ""
if ($allPassed) {
    Write-Host "✅ TODOS OS TESTES PASSARAM!" -ForegroundColor Green
} else {
    Write-Host "❌ ALGUNS TESTES FALHARAM!" -ForegroundColor Red
}

Write-Host ""
Write-Host "=== Como testar o fluxo completo LOCALMENTE ===" -ForegroundColor Cyan
Write-Host ""
Write-Host "Método 1: Usando o Mock Provider (sem Tailscale)" -ForegroundColor White
Write-Host "  1. Crie o arquivo network_session.json na raiz do projeto:" -ForegroundColor Gray
Write-Host '     { "provider": "mock", "credentials": { "fakeIp": "100.99.99.99" } }' -ForegroundColor Gray
Write-Host "  2. Rode: npm run tauri dev" -ForegroundColor Gray
Write-Host "  3. No host: clique em 'Iniciar Rede Mesh'" -ForegroundColor Gray
Write-Host "  4. O código de convite será gerado (ex: CF-XXXXXX63636363)" -ForegroundColor Gray
Write-Host "  5. Volte para início, vá em guest, cole o código e conecte" -ForegroundColor Gray
Write-Host "  6. O guest vai conectar 'virtualmente' (sem rede real)" -ForegroundColor Gray
Write-Host "  7. A descoberta vai falhar (sem sidecar Go), mas a UI será testada" -ForegroundColor Gray
Write-Host ""
Write-Host "Método 2: Testando o Registry HTTP diretamente" -ForegroundColor White
Write-Host "  1. Rode: npm run tauri dev" -ForegroundColor Gray
Write-Host "  2. O servidor HTTP de registro do Rust estará em 127.0.0.1:25567" -ForegroundColor Gray
Write-Host "  3. Teste manualmente com curl ou PowerShell:" -ForegroundColor Gray
Write-Host "     curl http://127.0.0.1:25567/status" -ForegroundColor Gray
Write-Host "     curl http://127.0.0.1:25567/registry/list" -ForegroundColor Gray
Write-Host "     curl http://127.0.0.1:25567/registry/resolve?code=SEUCODIGO" -ForegroundColor Gray
Write-Host ""
Write-Host "Método 3: Testando com dois terminais (host + guest simulados)" -ForegroundColor White
Write-Host "  1. Terminal 1 (host): npm run tauri dev" -ForegroundColor Gray
Write-Host "  2. No host: inicie a rede mesh (mock provider)" -ForegroundColor Gray
Write-Host "  3. Copie o código de convite" -ForegroundColor Gray
Write-Host "  4. Terminal 2: Use curl para simular o guest:" -ForegroundColor Gray
Write-Host "     curl 'http://127.0.0.1:25567/registry/resolve?code=SEUCODIGO'" -ForegroundColor Gray
Write-Host ""

# Limpar servidor de teste se foi iniciado por este script
if ($StartTestServer) {
    Write-Host "[CLEANUP] Encerrando servidor de teste..." -ForegroundColor Yellow
    Stop-Job $testServer -ErrorAction SilentlyContinue
    Remove-Job $testServer -ErrorAction SilentlyContinue
    Write-Host "[CLEANUP] Concluído!" -ForegroundColor Green
}
