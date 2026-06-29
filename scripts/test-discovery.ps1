# Script de Teste Local para Descoberta de Servidores
# 
# Este script simula o fluxo completo de descoberta de servidores
# sem precisar de dois computadores ou do Tailscale.
#
# Fluxo testado:
# 1. Inicia um servidor HTTP local (simulando o Rust registry)
# 2. Registra um servidor de teste
# 3. Simula a requisição que o guest faria via sidecar Go
# 4. Verifica se a resposta contém os metadados corretos

Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  Teste Local de Descoberta de Servidor" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

# Configurações
$registryPort = 25567
$shortCode = "TESTE1"
$serverName = "Meu Servidor Teste"
$serverVersion = "1.20.1"

# 1. Iniciar servidor HTTP de registro (simulando o Rust)
Write-Host "[1/4] Iniciando servidor HTTP de registro na porta $registryPort..." -ForegroundColor Yellow

# Usar um script PowerShell para criar um servidor HTTP simples
$serverScript = @"
using System;
using System.IO;
using System.Net;
using System.Text;
using System.Threading;

class RegistryServer {
    static void Main() {
        HttpListener listener = new HttpListener();
        listener.Prefixes.Add("http://127.0.0.1:$registryPort/");
        listener.Start();
        Console.WriteLine("[Registry] Servidor HTTP iniciado em 127.0.0.1:$registryPort");
        
        // Registrar servidor de teste
        string testEntry = '{"short_code":"$shortCode","name":"$serverName","version":"$serverVersion","server_type":"vanilla","description":"Servidor de teste local","status":"online","port":25565}';
        
        while (true) {
            HttpListenerContext ctx = listener.GetContext();
            HttpListenerRequest req = ctx.Request;
            HttpListenerResponse resp = ctx.Response;
            
            string url = req.Url.AbsolutePath + req.Url.Query;
            Console.WriteLine("[Registry] Requisição: " + req.HttpMethod + " " + url);
            
            string responseString = "";
            int statusCode = 200;
            
            if (url.StartsWith("/registry/resolve")) {
                // Extrair code da query string
                var query = System.Web.HttpUtility.ParseQueryString(req.Url.Query);
                string code = query["code"] ?? "";
                Console.WriteLine("[Registry] Resolvendo código: " + code);
                
                if (code == "$shortCode") {
                    responseString = testEntry;
                    Console.WriteLine("[Registry] Servidor encontrado!");
                } else {
                    statusCode = 404;
                    responseString = '{"error":"Servidor não encontrado para o código: ' + code + '"}';
                    Console.WriteLine("[Registry] Código não encontrado: " + code);
                }
            } else if (url == "/registry/list") {
                responseString = '[' + testEntry + ']';
            } else if (url == "/status") {
                responseString = '{"status":"ok"}';
            } else {
                statusCode = 404;
                responseString = '{"error":"Endpoint não encontrado"}';
            }
            
            byte[] buffer = Encoding.UTF8.GetBytes(responseString);
            resp.StatusCode = statusCode;
            resp.ContentType = "application/json";
            resp.Headers.Add("Access-Control-Allow-Origin", "*");
            resp.ContentLength64 = buffer.Length;
            resp.OutputStream.Write(buffer, 0, buffer.Length);
            resp.OutputStream.Close();
            
            if (url == "/registry/list") {
                // Após listar, esperar um pouco e sair
                Thread.Sleep(500);
                break;
            }
        }
        
        listener.Stop();
    }
}
"@

# Compilar e executar o servidor de teste
$serverDll = Join-Path $env:TEMP "RegistryServer.exe"
Add-Type -TypeDefinition $serverScript -Language CSharp -OutputAssembly $serverDll -OutputType ConsoleApplication

# Iniciar servidor em background
$serverJob = Start-Job -ScriptBlock {
    param($dll)
    & $dll
} -ArgumentList $serverDll

# Aguardar servidor iniciar
Start-Sleep -Seconds 2

Write-Host "[2/4] Servidor HTTP iniciado!" -ForegroundColor Green
Write-Host ""

# 2. Testar health check
Write-Host "[3/4] Testando endpoints..." -ForegroundColor Yellow

try {
    # Teste 1: Health check
    Write-Host "  Teste 1: GET /status" -NoNewline
    $status = Invoke-RestMethod -Uri "http://127.0.0.1:$registryPort/status" -TimeoutSec 5
    if ($status.status -eq "ok") {
        Write-Host " ✅ OK" -ForegroundColor Green
    } else {
        Write-Host " ❌ FALHOU" -ForegroundColor Red
    }

    # Teste 2: Resolver shortCode válido
    Write-Host "  Teste 2: GET /registry/resolve?code=$shortCode" -NoNewline
    $result = Invoke-RestMethod -Uri "http://127.0.0.1:$registryPort/registry/resolve?code=$shortCode" -TimeoutSec 5
    if ($result.short_code -eq $shortCode -and $result.name -eq $serverName) {
        Write-Host " ✅ OK" -ForegroundColor Green
        Write-Host "    Servidor: $($result.name) (v$($result.version))"
        Write-Host "    Status: $($result.status)"
        Write-Host "    Porta: $($result.port)"
    } else {
        Write-Host " ❌ FALHOU" -ForegroundColor Red
        Write-Host "    Resposta: $($result | ConvertTo-Json)"
    }

    # Teste 3: Resolver shortCode inválido (deve retornar 404)
    Write-Host "  Teste 3: GET /registry/resolve?code=INVALIDO" -NoNewline
    try {
        $invalidResult = Invoke-RestMethod -Uri "http://127.0.0.1:$registryPort/registry/resolve?code=INVALIDO" -TimeoutSec 5
        Write-Host " ❌ FALHOU (deveria retornar erro)" -ForegroundColor Red
    } catch {
        if ($_.Exception.Response.StatusCode -eq 404) {
            Write-Host " ✅ OK (404 esperado)" -ForegroundColor Green
        } else {
            Write-Host " ❌ FALHOU (status inesperado: $($_.Exception.Response.StatusCode))" -ForegroundColor Red
        }
    }

    # Teste 4: Listar todos os servidores
    Write-Host "  Teste 4: GET /registry/list" -NoNewline
    $list = Invoke-RestMethod -Uri "http://127.0.0.1:$registryPort/registry/list" -TimeoutSec 5
    if ($list.Count -ge 1 -and $list[0].short_code -eq $shortCode) {
        Write-Host " ✅ OK" -ForegroundColor Green
        Write-Host "    Servidores registrados: $($list.Count)"
    } else {
        Write-Host " ❌ FALHOU" -ForegroundColor Red
    }

} catch {
    Write-Host "  ❌ ERRO: $_" -ForegroundColor Red
}

Write-Host ""
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  Teste Concluído!" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "Para testar o fluxo completo (Rust + sidecar Go + frontend):" -ForegroundColor White
Write-Host "  1. Rode 'npm run tauri dev' para iniciar o app em modo desenvolvimento" -ForegroundColor Gray
Write-Host "  2. No host: clique em 'Iniciar Rede Mesh' (modo mock ou tailscale)" -ForegroundColor Gray
Write-Host "  3. Copie o código de convite gerado" -ForegroundColor Gray
Write-Host "  4. Volte para o início e vá em 'Entrar em um Jogo'" -ForegroundColor Gray
Write-Host "  5. Cole o código e clique em 'Conectar Agora'" -ForegroundColor Gray
Write-Host ""
Write-Host "Para testar LOCALMENTE (sem Tailscale):" -ForegroundColor Yellow
Write-Host "  1. Crie um arquivo network_session.json na raiz do projeto:" -ForegroundColor Gray
Write-Host '     { "provider": "mock", "credentials": { "fakeIp": "100.99.99.99" } }' -ForegroundColor Gray
Write-Host "  2. Rode 'npm run tauri dev'" -ForegroundColor Gray
Write-Host "  3. No host: inicie a rede mesh (usará o mock provider)" -ForegroundColor Gray
Write-Host "  4. O código de convite será CF-XXXXXX63636363 (IP fake)" -ForegroundColor Gray
Write-Host "  5. Volte para início, vá em guest, cole o código e conecte" -ForegroundColor Gray
Write-Host "  6. O guest vai conectar 'virtualmente' (sem rede real)" -ForegroundColor Gray
Write-Host "  7. A descoberta vai falhar (sem sidecar Go), mas o fluxo de UI será testado" -ForegroundColor Gray

# Limpar
Stop-Job $serverJob -ErrorAction SilentlyContinue
Remove-Job $serverJob -ErrorAction SilentlyContinue
Remove-Item $serverDll -ErrorAction SilentlyContinue
