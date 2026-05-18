#!/bin/bash
# Issue #23 — capture FS-outbound RTP packets to Megafon SBC for inter-packet
# timing analysis. Run inside WSL Ubuntu as root.
#
# Usage:
#   capture_rtp_to_megafon.sh start         # start tcpdump in background
#   capture_rtp_to_megafon.sh stop          # stop tcpdump
#   capture_rtp_to_megafon.sh analyze       # parse pcap, print packet deltas
#
# The capture filter narrows down to UDP packets going TO Megafon's SBC
# IP — that's exclusively our outbound RTP stream while a trunk call is
# active. SIP signalling is over a different transport (sip:sbc.megafon.ru
# would need a separate filter), but we only care about RTP pacing here.
set -e
SBC_IP=193.201.229.35
PCAP=/dev/shm/test-23/rtp.pcap
PIDFILE=/dev/shm/test-23/tcpdump.pid

case "${1:-}" in
    start)
        mkdir -p /dev/shm/test-23
        rm -f "$PCAP" "$PIDFILE"
        # -B 4096 = 4 MB ring buffer, plenty for ~10 s of RTP @ 50 pps
        # -s 200 = snap 200 bytes per packet (RTP header is 12 B, payload
        # 160 B for G.711 20ms — 200 B captures everything we need plus
        # IP/UDP headers)
        # -tt = unix-style absolute timestamps with microseconds
        # --immediate-mode = flush packets to disk without kernel batching
        # so we see real send timing, not buffered-and-flushed timing
        # Capture RTP-style UDP packets to/from FS on its FS RTP port
        # range (16384–32768). SIP signalling on port 5060 is excluded;
        # ICMP / DNS / NTP / DHCP / multicast / LAN-internal traffic
        # don't use this range. NB: filtering on src/dst NET 192.168.0/24
        # would erroneously match EVERY packet from FS (its own IP lives
        # there), so we rely on the port range instead.
        nohup tcpdump -i eth0 -w "$PCAP" -B 4096 -s 200 --immediate-mode \
            "udp and (portrange 16384-32768)" \
            >/dev/null 2>&1 &
        echo $! > "$PIDFILE"
        echo "tcpdump started pid=$(cat "$PIDFILE") pcap=$PCAP"
        ;;
    stop)
        if [ -f "$PIDFILE" ]; then
            kill -INT "$(cat "$PIDFILE")" 2>/dev/null || true
            sleep 0.5
            rm -f "$PIDFILE"
        fi
        if [ -s "$PCAP" ]; then
            echo "captured: $(stat -c '%s bytes' "$PCAP")"
        else
            echo "WARN: pcap empty or missing"
        fi
        ;;
    analyze)
        if [ ! -s "$PCAP" ]; then
            echo "no pcap at $PCAP"; exit 1
        fi
        LAN_IP=$(ip -4 addr show eth0 | awk '/inet /{print $2}' | cut -d/ -f1)
        echo "FS local IP: $LAN_IP"
        echo "SBC IP:      $SBC_IP (SIP signalling — RTP goes elsewhere)"
        echo
        echo "--- total packet count ---"
        tcpdump -r "$PCAP" -nn -q 2>/dev/null | wc -l
        echo
        echo "--- FS→remote (outbound RTP) by dst IP ---"
        tcpdump -r "$PCAP" -nn -q "src host $LAN_IP" 2>/dev/null \
            | awk '{print $5}' | sed 's/\.[0-9]*:$//' | sort | uniq -c | sort -rn
        echo
        echo "--- remote→FS (inbound RTP) by src IP ---"
        tcpdump -r "$PCAP" -nn -q "dst host $LAN_IP" 2>/dev/null \
            | awk '{print $3}' | sed 's/\.[0-9]*$//' | sort | uniq -c | sort -rn
        echo
        echo "--- first 10 outbound packets (FS→remote, absolute timestamps) ---"
        tcpdump -r "$PCAP" -tttt -nn -q "src host $LAN_IP" 2>/dev/null | head -10
        ;;
    *)
        echo "usage: $0 {start|stop|analyze}"; exit 1
        ;;
esac
