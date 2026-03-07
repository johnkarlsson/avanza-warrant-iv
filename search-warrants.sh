#!/usr/bin/env bash
#
# Search for warrants on Avanza using the market-warrant-filter API.
#
# Usage:
#   ./search-warrants.sh                          # show all warrants (first 20)
#   ./search-warrants.sh -u 5241                  # underlying instrument ID (e.g. Swedbank A)
#   ./search-warrants.sh -u 5241 -d short         # direction: long|short
#   ./search-warrants.sh -u 5241 -d short -t plain_vanilla  # subtype
#   ./search-warrants.sh -u 5241 -d short -t plain_vanilla -i "societe generale"
#   ./search-warrants.sh -s strikePrice -o asc    # sort field + order
#   ./search-warrants.sh -l 50                    # limit results
#   ./search-warrants.sh -r                       # raw JSON output
#
# Filter options (use --list-options to see valid values):
#   ./search-warrants.sh --list-options
#
# Sort fields: stopLoss, strikePrice, name, lastPrice, oneDayChangePercent, totalValueTraded
# Sort orders: asc, desc

set -euo pipefail

API_BASE="https://www.avanza.se/_api/market-warrant-filter"

# Defaults
UNDERLYING=""
DIRECTION=""
ISSUER=""
SUBTYPE=""
END_DATE=""
CATEGORY=""
EXPOSURE=""
SORT_FIELD="stopLoss"
SORT_ORDER="desc"
LIMIT=20
OFFSET=0
RAW=false
LIST_OPTIONS=false

usage() {
    sed -n '3,17p' "$0" | sed 's/^# \?//'
    exit 0
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        -u|--underlying)    UNDERLYING="$2"; shift 2 ;;
        -d|--direction)     DIRECTION="$2"; shift 2 ;;
        -i|--issuer)        ISSUER="$2"; shift 2 ;;
        -t|--subtype)       SUBTYPE="$2"; shift 2 ;;
        -e|--end-date)      END_DATE="$2"; shift 2 ;;
        -c|--category)      CATEGORY="$2"; shift 2 ;;
        -x|--exposure)      EXPOSURE="$2"; shift 2 ;;
        -s|--sort-field)    SORT_FIELD="$2"; shift 2 ;;
        -o|--sort-order)    SORT_ORDER="$2"; shift 2 ;;
        -l|--limit)         LIMIT="$2"; shift 2 ;;
        --offset)           OFFSET="$2"; shift 2 ;;
        -r|--raw)           RAW=true; shift ;;
        --list-options)     LIST_OPTIONS=true; shift ;;
        -h|--help)          usage ;;
        *) echo "Unknown option: $1" >&2; usage ;;
    esac
done

if $LIST_OPTIONS; then
    curl -s "$API_BASE/filter-options" | python3 -m json.tool
    exit 0
fi

# Build JSON arrays for each filter — empty string means empty array
to_json_array() {
    if [[ -z "$1" ]]; then
        echo "[]"
    else
        printf '["%s"]' "$1"
    fi
}

BODY=$(cat <<EOF
{
  "filter": {
    "underlyingInstruments": $(to_json_array "$UNDERLYING"),
    "directions": $(to_json_array "$DIRECTION"),
    "issuers": $(to_json_array "$ISSUER"),
    "subTypes": $(to_json_array "$SUBTYPE"),
    "endDates": $(to_json_array "$END_DATE"),
    "categories": $(to_json_array "$CATEGORY"),
    "exposures": $(to_json_array "$EXPOSURE"),
    "marketplaces": []
  },
  "offset": $OFFSET,
  "limit": $LIMIT,
  "sortBy": {
    "field": "$SORT_FIELD",
    "order": "$SORT_ORDER"
  }
}
EOF
)

RESPONSE=$(curl -s -X POST "$API_BASE/" \
    -H "Content-Type: application/json;charset=UTF-8" \
    -d "$BODY")

if $RAW; then
    echo "$RESPONSE" | python3 -m json.tool
    exit 0
fi

# Pretty-print as a table
TOTAL=$(echo "$RESPONSE" | python3 -c "import sys,json; print(json.load(sys.stdin).get('totalNumberOfOrderbooks', '?'))" 2>/dev/null)

echo "$RESPONSE" | python3 -c "
import sys, json

data = json.load(sys.stdin)
warrants = data.get('warrants', [])

if not warrants:
    print('No warrants found.')
    sys.exit(0)

# Header
print(f\"{'Name':<20} {'ID':<12} {'Direction':<10} {'Issuer':<20} {'Type':<16} {'Underlying':<15} {'Change%':>8} {'Traded':>10}\")
print('-' * 111)

for w in warrants:
    print(f\"{w['name']:<20} {w['orderbookId']:<12} {w['direction']:<10} {w['issuer']:<20} {w['subType']:<16} {w['underlyingInstrument']['name']:<15} {w.get('oneDayChangePercent', 0):>7.2f}% {w.get('totalValueTraded', 0):>10.0f}\")
"

echo ""
echo "Total: $TOTAL warrants matching filters"
