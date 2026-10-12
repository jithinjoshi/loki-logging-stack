#!/usr/bin/env bash
# Sends random requests to the app so Grafana has something to show.
# Usage: ./traffic.sh            (runs until Ctrl+C)
#        BASE=http://myhost:3000 ./traffic.sh

BASE="${BASE:-http://localhost:3000}"
echo "Sending traffic to $BASE  (Ctrl+C to stop)"

while true; do
  case $((RANDOM % 6)) in
    0) curl -s "$BASE/" ;;
    1) curl -s "$BASE/users/$((RANDOM % 150))" ;;   # >100 returns 404 (warn)
    2) curl -s -X POST "$BASE/payments" ;;          # ~30% fail (error)
    3) curl -s "$BASE/slow" ;;
    4) curl -s "$BASE/error" ;;                      # always 500 (error)
    5) curl -s "$BASE/users/$((RANDOM % 50))" ;;
  esac
  echo
  sleep 0.5
done
