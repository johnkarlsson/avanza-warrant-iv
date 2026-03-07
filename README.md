# Avanza Warrant Tools

Shell scripts for querying warrant data from Avanza's internal API. No authentication required.

## Scripts

### `search-warrants.sh` — Search & filter warrants

```bash
# All warrants (first 20)
./search-warrants.sh

# Filter by underlying instrument (Swedbank A = 5241)
./search-warrants.sh -u 5241

# Combine filters
./search-warrants.sh -u 5241 -d short -t plain_vanilla -i "societe generale"

# Custom sort and limit
./search-warrants.sh -u 5241 -s strikePrice -o asc -l 50

# Raw JSON output
./search-warrants.sh -u 5241 -r

# See all valid filter values (issuers, underlyings, dates, etc.)
./search-warrants.sh --list-options
```

### `get-warrant.sh` — Fetch details for a single warrant

```bash
# By orderbook ID (from search results or Avanza URL)
./get-warrant.sh 2072779

# Raw JSON
./get-warrant.sh 2072779 -r
```

## API Reference

### POST `/_api/market-warrant-filter/`

Filtered search for warrants. Returns a paginated list.

#### Request body

```json
{
  "filter": {
    "underlyingInstruments": ["5241"],
    "directions": ["short"],
    "issuers": ["societe generale"],
    "subTypes": ["plain_vanilla"],
    "endDates": ["2026-12-18"],
    "categories": ["warrant_asset|equity|root"],
    "exposures": ["sweden"],
    "marketplaces": []
  },
  "offset": 0,
  "limit": 20,
  "sortBy": {
    "field": "stopLoss",
    "order": "desc"
  }
}
```

All filter arrays can be empty `[]` (no filter) or contain one or more values.

#### Filter: `issuers`

| Value | Display Name |
|---|---|
| `bnp paribas` | BNP Paribas |
| `handelsbanken` | Handelsbanken |
| `j.p. morgan se` | J.P. Morgan SE |
| `morgan stanley` | Morgan Stanley |
| `nordea` | Nordea |
| `societe generale` | Societe Generale |
| `vontobel` | Vontobel |

#### Filter: `directions`

| Value | Display Name |
|---|---|
| `long` | Lång (Call/Bull) |
| `short` | Kort (Put/Bear) |

#### Filter: `subTypes`

| Value | Display Name |
|---|---|
| `plain_vanilla` | Warrant |
| `turbo` | Turbowarrant |
| `knock_out` | Knockoutwarrant |
| `mini_future` | Mini Future |

#### Filter: `underlyingInstruments`

Values are Avanza orderbook IDs. There are 1100+ underlyings. Some common ones:

| Value | Name | Warrants |
|---|---|---|
| `5241` | Swedbank A | 56 |
| `5364` | H&M B | 32 |
| `5401` | SAAB B | 32 |
| `5255` | SEB A | 31 |
| `52300` | Novo Nordisk B | 29 |
| `4478` | NVIDIA | 36 |
| `238449` | Tesla | 52 |
| `5269` | Volvo B | 45 |
| `155541` | Nasdaq 100 | 38 |
| `5234` | Atlas Copco A | 34 |
| `19002` | OMX Stockholm 30 | 33 |
| `18981` | DAX | 30 |
| `549768` | Evolution | 23 |
| `5240` | Ericsson B | 24 |
| `18986` | Guld (Gold) | 25 |
| `18991` | Silver | 25 |
| `350795` | Meta Platforms A | 17 |
| `155722` | Olja (Oil) | 8 |
| `19000` | USD/SEK | ? |

Use `./search-warrants.sh --list-options` for the complete list with current warrant counts.

#### Filter: `endDates`

Maturity dates in `YYYY-MM-DD` format. Valid values change over time. Use `--list-options` to see current dates.

#### Filter: `categories`

Hierarchical category strings using `|` as separator:

| Value | Description |
|---|---|
| `warrant_asset\|equity\|root` | Equities (stocks, indices, ETFs) |
| `single stock\|sub_level\|warrant_asset\|equity\|root` | Single stocks only |
| `stock index\|sub_level\|warrant_asset\|equity\|root` | Stock indices only |
| `dax\|sub_sub_level\|stock index\|sub_level\|warrant_asset\|equity\|root` | DAX specifically |
| `warrant_asset\|commodity\|root` | Commodities |
| `warrant_asset\|currency\|root` | Currencies |
| `warrant_asset\|fixed income\|root` | Fixed income / bonds |
| `warrant_asset\|alternative\|root` | Alternatives (crypto, etc.) |

#### Filter: `exposures`

| Value | Display Name |
|---|---|
| `sweden` | Sverige |
| `usa` | USA |
| `germany` | Tyskland |
| `denmark` | Danmark |
| `other` | Resten av världen |

#### Sort fields

Known working sort fields (used in `sortBy.field`):

- `stopLoss`
- `strikePrice`
- `name`
- `lastPrice`
- `oneDayChangePercent`
- `totalValueTraded`

Sort order: `asc` or `desc`.

#### Pagination

- `offset`: starting index (default 0)
- `limit`: max results per page (default 20)

#### Response

```json
{
  "warrants": [
    {
      "orderbookId": "2072779",
      "countryCode": "SE",
      "name": "SWE6X 240SG",
      "direction": "short",
      "issuer": "Societe Generale",
      "subType": "PLAIN_VANILLA",
      "hasPosition": false,
      "underlyingInstrument": {
        "name": "Swedbank A",
        "orderbookId": "5241",
        "instrumentType": "STOCK",
        "countryCode": "SE"
      },
      "totalValueTraded": 0,
      "oneDayChangePercent": 0.0
    }
  ],
  "filter": { ... },
  "pagination": { "offset": 0, "limit": 20 },
  "sortBy": { "field": "stopLoss", "order": "desc" },
  "totalNumberOfOrderbooks": 16,
  "filterOptions": { ... }
}

```

### GET `/_api/market-warrant-filter/filter-options`

Returns all valid filter values with current warrant counts. No parameters needed.

### GET `/_api/market-guide/warrant/{orderbookId}`

Returns detailed information about a single warrant including quote, key indicators, historical prices, and underlying instrument data.

#### Response fields

```json
{
  "orderbookId": "2072779",
  "name": "SWE6X 240SG",
  "isin": "DE000FA1R8U4",
  "tradable": "BUYABLE_AND_SELLABLE",
  "type": "WARRANT",
  "listing": {
    "shortName": "SWE6X 240SG",
    "tickerSymbol": "SWE6X 240SG",
    "currency": "SEK",
    "marketPlaceName": "Nordic MTF",
    "countryCode": "SE"
  },
  "keyIndicators": {
    "parity": 10,
    "direction": "Kort",
    "strikePrice": 240,
    "barrierLevel": 0,
    "financingLevel": 0,
    "numberOfOwners": 1,
    "subType": "PLAIN_VANILLA"
  },
  "quote": {
    "last": 0.5,
    "change": 0.0,
    "changePercent": 0.0,
    "timeOfLast": 1772830800000,
    "totalValueTraded": 0,
    "totalVolumeTraded": 0,
    "updated": 1772830804472
  },
  "historicalClosingPrices": {
    "oneDay": 0.5,
    "oneWeek": 1.31,
    "oneMonth": 1.31,
    "threeMonths": 1.31,
    "startOfYear": 1.31,
    "start": 1.31,
    "startDate": "2025-11-25"
  },
  "underlying": {
    "orderbookId": "5241",
    "name": "Swedbank A",
    "last": 332.3,
    "buy": 331.9,
    "sell": 332.1,
    "highest": 338.5,
    "lowest": 327.9,
    "change": -3.3,
    "changePercent": -0.98,
    "spread": 0.06,
    "totalValueTraded": 690154149.05,
    "totalVolumeTraded": 2074728,
    "previousClosingPrice": 335.6
  }
}
```

## Notes

- These APIs are **undocumented and unofficial**. They can change without warning.
- **No authentication** is required for these read-only market data endpoints.
- Avanza's terms of use prohibit automated access without written consent (see Företagswebb Användarvillkor).
- Data may be delayed by 15 minutes.
- The `keyIndicators` fields vary by warrant subType: plain vanilla warrants have `strikePrice`, mini futures have `barrierLevel` and `financingLevel`.
