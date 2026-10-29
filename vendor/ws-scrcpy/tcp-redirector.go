// tcp-redirector turns Android iptables REDIRECT connections into HTTP CONNECT
// requests for the host-direct relay. It runs as root inside the emulator so it
// can read SO_ORIGINAL_DST, while its own relay connection is not subject to
// the per-app firewall rules.
package main

import (
	"bufio"
	"encoding/binary"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"net"
	"strconv"
	"strings"
	"syscall"
	"time"
	"unsafe"
)

const soOriginalDst = 80

var (
	listenAddress = flag.String("listen", "127.0.0.1:7897", "local iptables REDIRECT listener")
	relayAddress  = flag.String("relay", "10.0.2.2:7899", "host-direct HTTP CONNECT relay")
	dialTimeout   = flag.Duration("dial-timeout", 12*time.Second, "relay connection timeout")
)

func main() {
	flag.Parse()
	listener, err := net.Listen("tcp4", *listenAddress)
	if err != nil {
		log.Fatalf("listen %s: %v", *listenAddress, err)
	}
	log.Printf("transparent TCP redirector listening on %s via %s", *listenAddress, *relayAddress)
	for {
		connection, acceptErr := listener.Accept()
		if acceptErr != nil {
			log.Printf("accept: %v", acceptErr)
			continue
		}
		go handle(connection)
	}
}

func handle(connection net.Conn) {
	client, ok := connection.(*net.TCPConn)
	if !ok {
		connection.Close()
		return
	}
	defer client.Close()
	client.SetKeepAlive(true)
	client.SetKeepAlivePeriod(30 * time.Second)

	destination, err := originalDestination(client)
	if err != nil {
		log.Printf("original destination: %v", err)
		return
	}
	relay, err := net.DialTimeout("tcp4", *relayAddress, *dialTimeout)
	if err != nil {
		log.Printf("relay %s for %s: %v", *relayAddress, destination, err)
		return
	}
	defer relay.Close()

	authority := net.JoinHostPort(destination.IP.String(), strconv.Itoa(destination.Port))
	if _, err = fmt.Fprintf(
		relay,
		"CONNECT %s HTTP/1.1\r\nHost: %s\r\nProxy-Connection: keep-alive\r\n\r\n",
		authority,
		authority,
	); err != nil {
		log.Printf("CONNECT %s: %v", authority, err)
		return
	}

	reader := bufio.NewReader(relay)
	status, err := reader.ReadString('\n')
	if err != nil {
		log.Printf("CONNECT response %s: %v", authority, err)
		return
	}
	fields := strings.Fields(status)
	if len(fields) < 2 || fields[1] != "200" {
		log.Printf("CONNECT rejected %s: %s", authority, strings.TrimSpace(status))
		return
	}
	for {
		line, readErr := reader.ReadString('\n')
		if readErr != nil {
			log.Printf("CONNECT headers %s: %v", authority, readErr)
			return
		}
		if line == "\r\n" || line == "\n" {
			break
		}
	}

	clientDone := make(chan struct{})
	go func() {
		_, _ = io.Copy(relay, client)
		if tcpRelay, relayOK := relay.(*net.TCPConn); relayOK {
			_ = tcpRelay.CloseWrite()
		}
		close(clientDone)
	}()
	_, _ = io.Copy(client, reader)
	_ = client.CloseWrite()
	<-clientDone
}

func originalDestination(connection *net.TCPConn) (*net.TCPAddr, error) {
	rawConnection, err := connection.SyscallConn()
	if err != nil {
		return nil, err
	}
	var (
		rawAddress  [128]byte
		addressSize = uint32(len(rawAddress))
		socketErr   error
	)
	controlErr := rawConnection.Control(func(fileDescriptor uintptr) {
		_, _, errno := syscall.Syscall6(
			syscall.SYS_GETSOCKOPT,
			fileDescriptor,
			uintptr(syscall.SOL_IP),
			uintptr(soOriginalDst),
			uintptr(unsafe.Pointer(&rawAddress[0])),
			uintptr(unsafe.Pointer(&addressSize)),
			0,
		)
		if errno != 0 {
			socketErr = errno
		}
	})
	if controlErr != nil {
		return nil, controlErr
	}
	if socketErr != nil {
		return nil, socketErr
	}
	if addressSize < 8 || binary.LittleEndian.Uint16(rawAddress[0:2]) != syscall.AF_INET {
		return nil, errors.New("SO_ORIGINAL_DST did not return an IPv4 sockaddr")
	}
	port := int(binary.BigEndian.Uint16(rawAddress[2:4]))
	if port < 1 {
		return nil, errors.New("SO_ORIGINAL_DST returned an invalid port")
	}
	return &net.TCPAddr{IP: net.IPv4(rawAddress[4], rawAddress[5], rawAddress[6], rawAddress[7]), Port: port}, nil
}
