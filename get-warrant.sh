#!/usr/bin/env bash
#
# Fetch detailed information about a single warrant from Avanza.
#
# Usage:
#   ./get-warrant.sh 2072779              # by orderbook ID
#   ./get-warrant.sh 2072779 -r           # raw JSON output
#
# The orderbook ID can be found via search-warrants.sh or from the Avanza URL:
#   https://www.avanza.se/.../om-warranten.html/<ID>/...

set -euo pipefail

API_BASE="https://www.avanza.se/_api/market-guide/warrant"

RAW=false

if [[ $# -lt 1 ]] || [[ "$1" == "-h" ]] || [[ "$1" == "--help" ]]; then
    sed -n '3,10p' "$0" | sed 's/^# \?//'
    exit 0
fi

WARRANT_ID="$1"
shift

while [[ $# -gt 0 ]]; do
    case "$1" in
        -r|--raw) RAW=true; shift ;;
        *) echo "Unknown option: $1" >&2; exit 1 ;;
    esac
done

RESPONSE=$(curl -s "$API_BASE/$WARRANT_ID")

# Check for error response
if echo "$RESPONSE" | python3 -c "import sys,json; d=json.load(sys.stdin); sys.exit(0 if 'statusCode' in d else 1)" 2>/dev/null; then
    echo "Error: $(echo "$RESPONSE" | python3 -c "import sys,json; d=json.load(sys.stdin); print(f\"{d.get('statusCode')}: {d.get('message')}\")")" >&2
    exit 1
fi

if $RAW; then
    echo "$RESPONSE" | python3 -m json.tool
    exit 0
fi

# Pretty-print key information
echo "$RESPONSE" | python3 -c "
import sys, json
from datetime import datetime

d = json.load(sys.stdin)

q = d.get('quote', {})
ki = d.get('keyIndicators', {})
listing = d.get('listing', {})
hist = d.get('historicalClosingPrices', {})
underlying = d.get('underlying', {})

def ts_to_str(ms):
    if not ms:
        return 'N/A'
    return datetime.fromtimestamp(ms / 1000).strftime('%Y-%m-%d %H:%M:%S')

print('=' * 60)
print(f\"  {d.get('name', 'N/A')}  ({d.get('type', '')})\")
print('=' * 60)
print()

print('Instrument')
print(f\"  ISIN:            {d.get('isin', 'N/A')}\")
print(f\"  Orderbook ID:    {d.get('orderbookId', 'N/A')}\")
print(f\"  Tradable:        {d.get('tradable', 'N/A')}\")
print(f\"  Market:          {listing.get('marketPlaceName', 'N/A')}\")
print(f\"  Currency:        {listing.get('currency', 'N/A')}\")
print()

print('Key Indicators')
print(f\"  Direction:       {ki.get('direction', 'N/A')}\")
print(f\"  Strike Price:    {ki.get('strikePrice', ki.get('financingLevel', 'N/A'))}\")
print(f\"  Parity:          {ki.get('parity', 'N/A')}\")
print(f\"  Sub Type:        {ki.get('subType', 'N/A')}\")
barrier = ki.get('barrierLevel')
if barrier:
    print(f\"  Barrier Level:   {barrier}\")
print(f\"  Owners:          {int(ki.get('numberOfOwners', 0))}\")
print()

print('Quote')
print(f\"  Last:            {q.get('last', 'N/A')} {listing.get('currency', '')}\")
print(f\"  Change:          {q.get('change', 'N/A')} ({q.get('changePercent', 'N/A')}%)\")
print(f\"  Volume:          {q.get('totalVolumeTraded', 'N/A')}\")
print(f\"  Turnover:        {q.get('totalValueTraded', 'N/A')}\")
print(f\"  Last Trade:      {ts_to_str(q.get('timeOfLast'))}\")
print()

print('Historical Closing Prices')
for label, key in [('1 Day', 'oneDay'), ('1 Week', 'oneWeek'), ('1 Month', 'oneMonth'),
                    ('3 Months', 'threeMonths'), ('Start of Year', 'startOfYear'),
                    ('At Launch', 'start')]:
    val = hist.get(key)
    if val is not None:
        print(f\"  {label + ':':<17}{val}\")
start_date = hist.get('startDate')
if start_date:
    print(f\"  {'Launch Date:':<17}{start_date}\")
print()

if underlying:
    uq = underlying.get('quote', underlying)
    print('Underlying: ' + underlying.get('name', 'N/A'))
    print(f\"  Last:            {uq.get('last', underlying.get('last', 'N/A'))}\")
    buy = uq.get('buy', underlying.get('buy'))
    sell = uq.get('sell', underlying.get('sell'))
    if buy is not None:
        print(f\"  Bid/Ask:         {buy} / {sell}\")
    spread = uq.get('spread', underlying.get('spread'))
    if spread is not None:
        print(f\"  Spread:          {spread}%\")
    high = uq.get('highest', underlying.get('highest'))
    low = uq.get('lowest', underlying.get('lowest'))
    if high is not None:
        print(f\"  Day Range:       {low} - {high}\")
    change = uq.get('change', underlying.get('change'))
    change_pct = uq.get('changePercent', underlying.get('changePercent'))
    if change is not None:
        print(f\"  Change:          {change} ({change_pct}%)\")
    prev = underlying.get('previousClosingPrice')
    if prev is not None:
        print(f\"  Prev Close:      {prev}\")
    vol = uq.get('totalVolumeTraded', underlying.get('totalVolumeTraded'))
    if vol is not None:
        print(f\"  Volume:          {vol:,.0f}\")
    turnover = uq.get('totalValueTraded', underlying.get('totalValueTraded'))
    if turnover is not None:
        print(f\"  Turnover:        {turnover:,.2f}\")
    print(f\"  Market:          {underlying.get('marketPlaceName', 'N/A')}\")
"
