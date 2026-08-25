package main

import (
	"bufio"
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"tailscale.com/tsnet"
)

type Config struct {
	AuthKey  string `json:"authKey"`
	Hostname string `json:"hostname"`
	Mode     string `json:"mode"` // "host" or "guest"
	TargetIP string `json:"targetIp,omitempty"` // Virtual IP of the host (for guest mode)
	LocalPort int   `json:"localPort"`           // Local port to listen on or forward to
}

// ErrorPayload é o formato estruturado impresso no stdout antes de sair em caso
// de erro fatal. O processo Rust pai parseia essa linha (procura por `"error"`
// no JSON) e traduz `Code` para uma mensagem amigável na Central de Diagnósticos,
// em vez de só saber que "o sidecar morreu" com um código de saída genérico.
type ErrorPayload struct {
	Error  string `json:"error"`
	Detail string `json:"detail"`
}

// fatalWithCode imprime a causa do erro em stdout (como JSON, na mesma linha de
// output que o Rust já escuta) e encerra o processo. Substitui log.Fatalf, cujo
// texto ia para stderr como log solto sem estrutura reconhecível pelo Rust.
func fatalWithCode(code string, err error) {
	detail := ""
	if err != nil {
		detail = err.Error()
	}
	if b, mErr := json.Marshal(ErrorPayload{Error: code, Detail: detail}); mErr == nil {
		fmt.Println(string(b))
	}
	os.Exit(1)
}

func main() {
	useStdin := flag.Bool("stdin", false, "Read config from stdin (first line)")
	configPath := flag.String("config", "", "Path to JSON config file")
	flag.Parse()

	var cfg Config

	if *useStdin {
		// Ler configuração da primeira linha do stdin (pipe anônimo)
		// O pai (Rust) escreve a primeira linha como JSON e fecha o pipe
		// Depois continuamos monitorando stdin para detectar morte do pai
		scanner := bufio.NewScanner(os.Stdin)
		if scanner.Scan() {
			line := scanner.Text()
			if err := json.Unmarshal([]byte(line), &cfg); err != nil {
				fatalWithCode("config_decode_failed", err)
			}
		} else {
			fatalWithCode("config_read_failed", scanner.Err())
		}

		// Continuar monitorando stdin para detectar quando o pai morrer
		// (as linhas seguintes do stdin serão lidas em background)
		go func() {
			buf := make([]byte, 1)
			for {
				_, err := os.Stdin.Read(buf)
				if err != nil { // io.EOF or other read error
					os.Exit(0)
				}
			}
		}()
	} else if *configPath != "" {
		// Modo legado: ler de arquivo
		configFile, err := os.Open(*configPath)
		if err != nil {
			fatalWithCode("config_read_failed", err)
		}
		defer configFile.Close()

		if err := json.NewDecoder(configFile).Decode(&cfg); err != nil {
			fatalWithCode("config_decode_failed", err)
		}

		// Monitor stdin to exit if parent process closes
		go func() {
			buf := make([]byte, 1)
			for {
				_, err := os.Stdin.Read(buf)
				if err != nil { // io.EOF or other read error
					os.Exit(0)
				}
			}
		}()
	} else {
		fatalWithCode("config_missing", nil)
	}

	s := &tsnet.Server{
		Hostname: cfg.Hostname,
		AuthKey:  cfg.AuthKey,
		Logf:     func(format string, args ...any) {}, // Silent for now
	}
	defer s.Close()

	// Up connects to the tailnet and blocks until the node is authorized and has its IP address
	status, err := s.Up(context.Background())
	if err != nil {
		fatalWithCode("mesh_auth_failed", err)
	}

	if len(status.TailscaleIPs) == 0 {
		fatalWithCode("no_ip_assigned", nil)
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	// Confirmar que o listener local/mesh realmente abre ANTES de reportar "online".
	// Reportar online cedo demais (e só descobrir o bind falho um instante depois)
	// fazia a UI "piscar" online→offline sem explicação clara.
	var ln net.Listener
	if cfg.Mode == "host" {
		ln, err = s.Listen("tcp", ":25565")
		if err != nil {
			fatalWithCode("listen_mesh_failed", err)
		}
	} else {
		ln, err = net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", cfg.LocalPort))
		if err != nil {
			fatalWithCode("listen_local_failed", err)
		}
	}

	fmt.Printf("{\"status\": \"online\", \"ip\": \"%s\"}\n", status.TailscaleIPs[0])

	if cfg.Mode == "host" {
		go startHostMode(ctx, s, cfg, ln)
	} else {
		go startGuestMode(ctx, s, cfg, ln)
	}

	// Wait for exit signal
	sigChan := make(chan os.Signal, 1)
	signal.Notify(sigChan, syscall.SIGINT, syscall.SIGTERM)
	<-sigChan
}

func startHostMode(ctx context.Context, s *tsnet.Server, cfg Config, ln net.Listener) {
	defer ln.Close()

	fmt.Printf("{\"info\": \"Host listening on :25565\"}\n")

	// Start HTTP API server on Tailscale port 25566
	go startHTTPServer(ctx, s)

	for {
		conn, err := ln.Accept()
		if err != nil {
			log.Printf("Accept error: %v", err)
			continue
		}
		go proxyConn(conn, fmt.Sprintf("127.0.0.1:%d", cfg.LocalPort))
	}
}

func startGuestMode(ctx context.Context, s *tsnet.Server, cfg Config, ln net.Listener) {
	defer ln.Close()

	fmt.Printf("{\"info\": \"Guest listening on localhost:%d -> %s:25565\"}\n", cfg.LocalPort, cfg.TargetIP)

	for {
		conn, err := ln.Accept()
		if err != nil {
			log.Printf("Local accept error: %v", err)
			continue
		}

		// Timeout no Dial: sem isso, um host inalcançável na malha deixava esta
		// goroutine pendurada indefinidamente em vez de falhar e liberar a conexão.
		dialCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
		targetConn, err := s.Dial(dialCtx, "tcp", fmt.Sprintf("%s:25565", cfg.TargetIP))
		cancel()
		if err != nil {
			log.Printf("Dial error: %v", err)
			conn.Close()
			continue
		}
		go handleProxy(conn, targetConn)
	}
}

// startHTTPServer inicia um servidor HTTP na Tailscale (porta 25566)
// que serve como API pública para descoberta de servidores.
// Ele faz proxy das requisições para o servidor HTTP interno do Rust (127.0.0.1:25567).
func startHTTPServer(ctx context.Context, s *tsnet.Server) {
	log.Printf("[HTTP] Tentando escutar em tsnet::25566...")
	ln, err := s.Listen("tcp", ":25566")
	if err != nil {
		log.Printf("[HTTP] ERRO ao escutar em tsnet:25566: %v", err)
		return
	}
	defer ln.Close()

	log.Printf("[HTTP] Listener criado com sucesso em tsnet:25566")
	fmt.Printf("{\"info\": \"HTTP API listening on :25566\"}\n")

	mux := http.NewServeMux()
	
	// GET /resolve?code=XXXXXX — Resolve um código de convite para metadados do servidor
	// Faz proxy para o Rust em 127.0.0.1:25567/registry/resolve?code={shortCode}
	mux.HandleFunc("/resolve", func(w http.ResponseWriter, r *http.Request) {
		log.Printf("[HTTP] Requisição recebida: %s %s de %s", r.Method, r.URL.String(), r.RemoteAddr)
		
		if r.Method != http.MethodGet {
			http.Error(w, `{"error":"method not allowed"}`, http.StatusMethodNotAllowed)
			return
		}
		
		code := r.URL.Query().Get("code")
		log.Printf("[HTTP] Código recebido: '%s'", code)
		if code == "" {
			http.Error(w, `{"error":"code parameter is required"}`, http.StatusBadRequest)
			return
		}
		
		// Extrair o shortCode do código de convite (formato: CF-{shortCode6}{ipHex8})
		shortCode := extractShortCode(code)
		log.Printf("[HTTP] ShortCode extraído: '%s'", shortCode)
		if shortCode == "" {
			http.Error(w, `{"error":"invalid invite code format"}`, http.StatusBadRequest)
			return
		}
		
		// Fazer proxy para o Rust
		log.Printf("[HTTP] Fazendo proxy para Rust: http://127.0.0.1:25567/registry/resolve?code=%s", shortCode)
		proxyToRust(w, fmt.Sprintf("http://127.0.0.1:25567/registry/resolve?code=%s", shortCode))
	})

	// GET /status — Health check
	mux.HandleFunc("/status", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		json.NewEncoder(w).Encode(map[string]string{"status": "ok"})
	})

	server := &http.Server{
		Handler: mux,
		// Timeouts para evitar conexões penduradas
		ReadTimeout:  10 * time.Second,
		WriteTimeout: 10 * time.Second,
	}

	// Rodar servidor HTTP até o contexto ser cancelado
	go func() {
		<-ctx.Done()
		server.Close()
	}()

	if err := server.Serve(ln); err != nil && err != http.ErrServerClosed {
		log.Printf("HTTP server error: %v", err)
	}
}

// extractShortCode extrai o shortCode de 6 caracteres de um código de convite.
// Aceita dois formatos:
// 1. Código completo: CF-{shortCode6}{ipHex8} (ex: CF-X7K9M26454150A)
// 2. ShortCode puro: {shortCode6} (ex: X7K9M2)
func extractShortCode(code string) string {
	clean := strings.TrimSpace(code)
	clean = strings.ToUpper(clean)
	
	// Formato 2: ShortCode puro (6 caracteres, sem "CF-")
	// Ex: "LYW4FZ" ou "X7K9M2"
	if len(clean) == 6 && !strings.HasPrefix(clean, "CF-") {
		return clean
	}
	
	// Formato 1: Código de convite completo com "CF-"
	if !strings.HasPrefix(clean, "CF-") {
		return ""
	}
	
	payload := clean[3:] // Remove "CF-"
	
	// Formato novo: CF-{shortCode6}{ipHex8} = 14 chars
	if len(payload) == 14 {
		return payload[:6] // shortCode são os primeiros 6 caracteres
	}
	
	// Formato legado: CF-{ipHex8} = 8 chars (sem shortCode)
	if len(payload) == 8 {
		return "" // código legado, sem shortCode
	}
	
	return ""
}

// proxyToRust faz uma requisição HTTP para o servidor interno do Rust e escreve a resposta
func proxyToRust(w http.ResponseWriter, url string) {
	client := &http.Client{
		Timeout: 5 * time.Second,
	}
	
	resp, err := client.Get(url)
	if err != nil {
		log.Printf("Proxy error: %v", err)
		http.Error(w, fmt.Sprintf(`{"error":"internal server error: %v"}`, err), http.StatusBadGateway)
		return
	}
	defer resp.Body.Close()
	
	// Copiar headers
	for key, values := range resp.Header {
		for _, value := range values {
			w.Header().Add(key, value)
		}
	}
	
	w.WriteHeader(resp.StatusCode)
	io.Copy(w, resp.Body)
}

func proxyConn(conn net.Conn, targetAddr string) {
	defer conn.Close()
	target, err := net.Dial("tcp", targetAddr)
	if err != nil {
		log.Printf("Target dial error: %v", err)
		return
	}
	defer target.Close()
	handleProxy(conn, target)
}

func handleProxy(c1, c2 net.Conn) {
	defer c1.Close()
	defer c2.Close()
	errc := make(chan error, 2)
	go func() {
		_, err := io.Copy(c1, c2)
		errc <- err
	}()
	go func() {
		_, err := io.Copy(c2, c1)
		errc <- err
	}()
	<-errc
}
