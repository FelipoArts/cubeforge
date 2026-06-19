package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"log"
	"net"
	"os"
	"os/signal"
	"syscall"

	"tailscale.com/tsnet"
)

type Config struct {
	AuthKey  string `json:"authKey"`
	Hostname string `json:"hostname"`
	Mode     string `json:"mode"` // "host" or "guest"
	TargetIP string `json:"targetIp,omitempty"` // Virtual IP of the host (for guest mode)
	LocalPort int   `json:"localPort"`           // Local port to listen on or forward to
}

func main() {
	configPath := flag.String("config", "", "Path to JSON config file")
	flag.Parse()

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

	if *configPath == "" {
		log.Fatal("Config path is required")
	}

	configFile, err := os.Open(*configPath)
	if err != nil {
		log.Fatalf("Failed to open config: %v", err)
	}
	defer configFile.Close()

	var cfg Config
	if err := json.NewDecoder(configFile).Decode(&cfg); err != nil {
		log.Fatalf("Failed to decode config: %v", err)
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
		log.Fatalf("Failed to start tsnet: %v", err)
	}

	if len(status.TailscaleIPs) == 0 {
		log.Fatalf("No Tailscale IPs assigned to the node")
	}

	fmt.Printf("{\"status\": \"online\", \"ip\": \"%s\"}\n", status.TailscaleIPs[0])

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	if cfg.Mode == "host" {
		startHostMode(ctx, s, cfg)
	} else {
		startGuestMode(ctx, s, cfg)
	}

	// Wait for exit signal
	sigChan := make(chan os.Signal, 1)
	signal.Notify(sigChan, syscall.SIGINT, syscall.SIGTERM)
	<-sigChan
}

func startHostMode(ctx context.Context, s *tsnet.Server, cfg Config) {
	// Listen on the Tailscale network (Minecraft port 25565)
	ln, err := s.Listen("tcp", ":25565")
	if err != nil {
		log.Fatalf("Failed to listen on tsnet: %v", err)
	}
	defer ln.Close()

	fmt.Printf("{\"info\": \"Host listening on :25565\"}\n")

	for {
		conn, err := ln.Accept()
		if err != nil {
			log.Printf("Accept error: %v", err)
			continue
		}
		go proxyConn(conn, fmt.Sprintf("127.0.0.1:%d", cfg.LocalPort))
	}
}

func startGuestMode(ctx context.Context, s *tsnet.Server, cfg Config) {
	// Listen on local machine to redirect to host
	ln, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", cfg.LocalPort))
	if err != nil {
		log.Fatalf("Failed to listen locally: %v", err)
	}
	defer ln.Close()

	fmt.Printf("{\"info\": \"Guest listening on localhost:%d -> %s:25565\"}\n", cfg.LocalPort, cfg.TargetIP)

	for {
		conn, err := ln.Accept()
		if err != nil {
			log.Printf("Local accept error: %v", err)
			continue
		}
		
		targetConn, err := s.Dial(ctx, "tcp", fmt.Sprintf("%s:25565", cfg.TargetIP))
		if err != nil {
			log.Printf("Dial error: %v", targetConn)
			conn.Close()
			continue
		}
		go handleProxy(conn, targetConn)
	}
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
