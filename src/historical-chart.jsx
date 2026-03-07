import { useState, useEffect, useMemo } from "react";
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
} from "recharts";

// ── Avanza stock search ─────────────────────────────────────────────────────

const searchCache = new Map();

async function searchStock(query) {
  const lowerQuery = query.toLowerCase();
  for (const [, entry] of searchCache) {
    if (entry.title.toLowerCase().includes(lowerQuery)) return [entry];
  }

  const res = await fetch("/api/search/filtered-search", {
    method: "POST",
    headers: { "Content-Type": "application/json;charset=UTF-8" },
    body: JSON.stringify({
      query,
      searchFilter: { types: ["STOCK"] },
      screenSize: "DESKTOP",
      originPath: "/",
      originPlatform: "PWA",
      searchSessionId: "chart",
      pagination: { from: 0, size: 5 },
    }),
  });
  if (!res.ok) throw new Error(`Search failed: HTTP ${res.status}`);
  const data = await res.json();
  const stocks = (data.hits || []).filter((h) => h.type === "STOCK");
  if (stocks.length > 0) {
    const top = stocks[0];
    searchCache.set(top.orderBookId, top);
  }
  return stocks;
}

// ── Constants ────────────────────────────────────────────────────────────────

const INTERVALS = [
  { label: "1W", timePeriod: "one_week" },
  { label: "1M", timePeriod: "one_month" },
  { label: "3M", timePeriod: "three_months" },
  { label: "6M", timePeriod: "six_months" },
  { label: "1Y", timePeriod: "one_year" },
  { label: "5Y", timePeriod: "five_years" },
];

const CACHE_TTL = 5 * 60 * 1000;
const cache = new Map();

// ── Data fetching with retry ─────────────────────────────────────────────────

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchChart(stockId, timePeriod, retries = 3) {
  const key = `${stockId}:${timePeriod}`;
  const cached = cache.get(key);
  if (cached && Date.now() - cached.time < CACHE_TTL) return cached.data;

  let lastErr;
  for (let attempt = 0; attempt < retries; attempt++) {
    if (attempt > 0) await delay(1000 * 2 ** attempt);
    try {
      const res = await fetch(
        `/api/price-chart/stock/${stockId}?timePeriod=${timePeriod}`
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      const ohlc = json.ohlc;
      if (!ohlc || ohlc.length === 0) throw new Error("No data returned");

      const data = ohlc
        .filter((d) => d.close != null)
        .map((d) => ({
          ts: d.timestamp,
          close: d.close,
          high: d.high,
          low: d.low,
          volume: d.totalVolumeTraded,
        }));
      if (data.length === 0) throw new Error("No data points");

      cache.set(key, { data, time: Date.now() });
      return data;
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr;
}

// ── Realized volatility ─────────────────────────────────────────────────────

function calcRealizedVol(closes, window) {
  if (closes.length < window + 1) return null;
  const slice = closes.slice(-(window + 1));
  const returns = [];
  for (let i = 1; i < slice.length; i++) {
    returns.push(Math.log(slice[i] / slice[i - 1]));
  }
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance =
    returns.reduce((a, r) => a + (r - mean) ** 2, 0) / (returns.length - 1);
  return Math.sqrt(variance * 252) * 100;
}

function volRegime(vol) {
  if (vol < 20) return { label: "Low vol regime", color: "#4caf50" };
  if (vol < 35) return { label: "Normal", color: "#4fc3f7" };
  if (vol < 50) return { label: "Elevated", color: "#ff9800" };
  return { label: "Crisis-level", color: "#e53935" };
}

// ── Styles ───────────────────────────────────────────────────────────────────

const cardStyle = {
  background: "#111728",
  borderRadius: 10,
  border: "1px solid #1a2035",
  overflow: "hidden",
  marginBottom: 28,
};

const statBox = {
  background: "#0a0e17",
  borderRadius: 8,
  padding: "10px 14px",
  border: "1px solid #1a2035",
  minWidth: 0,
};

// ── Component ────────────────────────────────────────────────────────────────

export default function HistoricalChart({ underlyingName, underlyingId, medianIV }) {
  const [intervalIdx, setIntervalIdx] = useState(2);
  const [stockId, setStockId] = useState(underlyingId || "");
  const [stockLabel, setStockLabel] = useState(underlyingName || "");
  const [searchInput, setSearchInput] = useState(underlyingName || "");
  const [chartData, setChartData] = useState([]);
  const [dailyCloses, setDailyCloses] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [showVolInfo, setShowVolInfo] = useState(false);

  useEffect(() => {
    if (underlyingId) {
      setStockId(underlyingId);
      setStockLabel(underlyingName || "");
      setSearchInput(underlyingName || "");
    }
  }, [underlyingId, underlyingName]);

  useEffect(() => {
    if (!stockId) return;
    let cancelled = false;
    const { timePeriod } = INTERVALS[intervalIdx];

    setLoading(true);
    setError(null);

    (async () => {
      try {
        const data = await fetchChart(stockId, timePeriod);
        if (cancelled) return;
        setChartData(data);

        try {
          const daily = await fetchChart(stockId, "one_year");
          if (!cancelled) setDailyCloses(daily.map((p) => p.close));
        } catch {
          // Vol data is secondary
        }
      } catch (e) {
        if (!cancelled) {
          setError(e.message);
          setChartData([]);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => { cancelled = true; };
  }, [stockId, intervalIdx]);

  const stats = useMemo(() => {
    if (!chartData.length) return null;
    const closes = chartData.map((d) => d.close);
    const first = closes[0];
    const last = closes[closes.length - 1];
    return {
      current: last,
      high: Math.max(...closes),
      low: Math.min(...closes),
      change: ((last - first) / first) * 100,
    };
  }, [chartData]);

  const rv = useMemo(
    () => ({
      rv30: calcRealizedVol(dailyCloses, 30),
      rv60: calcRealizedVol(dailyCloses, 60),
      rv90: calcRealizedVol(dailyCloses, 90),
    }),
    [dailyCloses]
  );

  const regime = rv.rv30 != null ? volRegime(rv.rv30) : null;

  const formatDate = (ts) => {
    const d = new Date(ts);
    if (intervalIdx === 0) {
      return (
        d.toLocaleDateString("en", { weekday: "short" }) +
        " " +
        d.toLocaleTimeString("en", {
          hour: "2-digit",
          minute: "2-digit",
          hour12: false,
        })
      );
    }
    if (intervalIdx <= 2) {
      return d.toLocaleDateString("en", { month: "short", day: "numeric" });
    }
    if (intervalIdx <= 4) {
      return d.toLocaleDateString("en", { month: "short", year: "numeric" });
    }
    return d.getFullYear().toString();
  };

  const formattedData = useMemo(
    () => chartData.map((d) => ({ ...d, dateLabel: formatDate(d.ts) })),
    [chartData, intervalIdx]
  );

  const handleSearch = async () => {
    const val = searchInput.trim();
    if (!val) return;
    try {
      const results = await searchStock(val);
      if (results.length > 0) {
        setStockId(results[0].orderBookId);
        setStockLabel(results[0].title);
      } else {
        setError(`No stocks found for "${val}"`);
      }
    } catch (e) {
      setError(e.message);
    }
  };

  const ivRvDiff = (rvVal) => {
    if (rvVal == null || medianIV == null) return null;
    const diff = medianIV - rvVal;
    if (Math.abs(diff) < 2) return { label: "Fair", color: "#6b7394" };
    if (diff > 0) return { label: "IV Premium", color: "#ff9800" };
    return { label: "IV Discount", color: "#4caf50" };
  };

  if (!underlyingName) return null;

  return (
    <div style={cardStyle}>
      {/* Header */}
      <div
        style={{
          padding: "16px 24px",
          borderBottom: "1px solid #1a2035",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          flexWrap: "wrap",
          gap: 12,
        }}
      >
        <div>
          <h2
            style={{
              fontFamily: "'DM Sans', sans-serif",
              fontSize: 16,
              fontWeight: 600,
              color: "#fff",
            }}
          >
            Historical Price & Realized Vol
          </h2>
          <p style={{ fontSize: 11, color: "#6b7394", marginTop: 4 }}>
            {underlyingName}
            {stockLabel && (
              <span style={{ color: "#4fc3f7", marginLeft: 6 }}>{stockLabel}</span>
            )}
          </p>
        </div>

        <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
          <input
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleSearch()}
            placeholder="Search stock (e.g. Swedbank A)"
            style={{
              background: "#0a0e17",
              border: "1px solid #1a2035",
              borderRadius: 6,
              padding: "6px 10px",
              color: "#fff",
              fontSize: 12,
              fontFamily: "'JetBrains Mono', monospace",
              width: 180,
              outline: "none",
            }}
          />
          <button
            onClick={handleSearch}
            style={{
              padding: "6px 12px",
              borderRadius: 6,
              border: "1px solid #4fc3f7",
              background: "rgba(79,195,247,0.1)",
              color: "#4fc3f7",
              fontSize: 11,
              fontFamily: "'JetBrains Mono', monospace",
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            Load
          </button>
        </div>
      </div>

      <div style={{ padding: "20px 24px" }}>
        {/* Interval pills */}
        <div style={{ display: "flex", gap: 6, marginBottom: 16 }}>
          {INTERVALS.map((iv, i) => (
            <button
              key={iv.label}
              onClick={() => setIntervalIdx(i)}
              style={{
                padding: "6px 12px",
                borderRadius: 6,
                border:
                  i === intervalIdx
                    ? "1px solid #4fc3f7"
                    : "1px solid #1a2035",
                background:
                  i === intervalIdx ? "rgba(79,195,247,0.1)" : "transparent",
                color: i === intervalIdx ? "#4fc3f7" : "#6b7394",
                fontSize: 11,
                fontFamily: "'JetBrains Mono', monospace",
                fontWeight: 600,
                cursor: "pointer",
                letterSpacing: 0.5,
              }}
            >
              {iv.label}
            </button>
          ))}
        </div>

        {/* Error */}
        {error && (
          <div
            style={{
              padding: "10px 14px",
              background: "rgba(229,57,53,0.08)",
              border: "1px solid rgba(229,57,53,0.25)",
              borderRadius: 6,
              fontSize: 12,
              color: "#e53935",
              marginBottom: 16,
            }}
          >
            Failed to load data: {error}. Try searching for a different stock
            above.
          </div>
        )}

        {/* Loading */}
        {loading && (
          <div
            style={{
              textAlign: "center",
              padding: "40px 0",
              color: "#6b7394",
              fontSize: 13,
            }}
          >
            Loading chart data...
          </div>
        )}

        {/* No ticker */}
        {!stockId && !loading && (
          <div
            style={{
              textAlign: "center",
              padding: "40px 0",
              color: "#6b7394",
              fontSize: 13,
            }}
          >
            Search for a stock above to load historical data.
          </div>
        )}

        {/* Stats + Chart */}
        {stats && !loading && (
          <>
            {/* Stats row */}
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(4, 1fr)",
                gap: 10,
                marginBottom: 16,
              }}
            >
              {[
                {
                  label: "Current",
                  value: stats.current.toFixed(2),
                  color: "#fff",
                },
                {
                  label: "Period High",
                  value: stats.high.toFixed(2),
                  color: "#4caf50",
                },
                {
                  label: "Period Low",
                  value: stats.low.toFixed(2),
                  color: "#e53935",
                },
                {
                  label: "Period Change",
                  value: `${stats.change >= 0 ? "+" : ""}${stats.change.toFixed(1)}%`,
                  color: stats.change >= 0 ? "#4caf50" : "#e53935",
                },
              ].map((s, i) => (
                <div key={i} style={statBox}>
                  <div
                    style={{
                      fontSize: 9,
                      color: "#6b7394",
                      textTransform: "uppercase",
                      letterSpacing: 1,
                      marginBottom: 2,
                    }}
                  >
                    {s.label}
                  </div>
                  <div
                    style={{ fontSize: 16, fontWeight: 600, color: s.color }}
                  >
                    {s.value}
                  </div>
                </div>
              ))}
            </div>

            {/* Chart */}
            <div style={{ marginBottom: 20 }}>
              <ResponsiveContainer width="100%" height={280}>
                <AreaChart data={formattedData}>
                  <defs>
                    <linearGradient id="chartGrad" x1="0" y1="0" x2="0" y2="1">
                      <stop
                        offset="0%"
                        stopColor="#4fc3f7"
                        stopOpacity={0.15}
                      />
                      <stop
                        offset="100%"
                        stopColor="#4fc3f7"
                        stopOpacity={0}
                      />
                    </linearGradient>
                  </defs>
                  <CartesianGrid
                    stroke="#1a2035"
                    strokeDasharray="3 3"
                    vertical={false}
                  />
                  <XAxis
                    dataKey="dateLabel"
                    tick={{
                      fill: "#6b7394",
                      fontSize: 10,
                      fontFamily: "'JetBrains Mono', monospace",
                    }}
                    axisLine={{ stroke: "#1a2035" }}
                    tickLine={false}
                    interval="preserveStartEnd"
                    minTickGap={50}
                  />
                  <YAxis
                    domain={["auto", "auto"]}
                    tick={{
                      fill: "#6b7394",
                      fontSize: 10,
                      fontFamily: "'JetBrains Mono', monospace",
                    }}
                    axisLine={false}
                    tickLine={false}
                    width={60}
                    tickFormatter={(v) => v.toFixed(0)}
                  />
                  <Tooltip
                    contentStyle={{
                      background: "#0a0e17",
                      border: "1px solid #1a2035",
                      borderRadius: 6,
                      fontSize: 12,
                      fontFamily: "'JetBrains Mono', monospace",
                    }}
                    labelStyle={{ color: "#6b7394", fontSize: 11 }}
                    itemStyle={{ color: "#4fc3f7" }}
                    formatter={(value) => [value.toFixed(2) + " SEK", "Close"]}
                  />
                  <Area
                    type="monotone"
                    dataKey="close"
                    stroke="#4fc3f7"
                    strokeWidth={2}
                    fill="url(#chartGrad)"
                    dot={false}
                    activeDot={{
                      r: 4,
                      fill: "#4fc3f7",
                      stroke: "#0a0e17",
                      strokeWidth: 2,
                    }}
                  />
                </AreaChart>
              </ResponsiveContainer>
            </div>

            {/* ── Realized Vol Section ── */}
            <div style={{ borderTop: "1px solid #1a2035", paddingTop: 16 }}>
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  marginBottom: 12,
                }}
              >
                <h3
                  style={{
                    fontFamily: "'DM Sans', sans-serif",
                    fontSize: 14,
                    fontWeight: 600,
                    color: "#fff",
                  }}
                >
                  Realized Volatility
                </h3>
                {regime && (
                  <div
                    style={{ display: "flex", alignItems: "center", gap: 8 }}
                  >
                    <span
                      style={{
                        fontSize: 11,
                        fontWeight: 600,
                        color: regime.color,
                        background: `${regime.color}15`,
                        padding: "4px 10px",
                        borderRadius: 4,
                        border: `1px solid ${regime.color}40`,
                      }}
                    >
                      {regime.label}
                    </span>
                    <button
                      onClick={() => setShowVolInfo(!showVolInfo)}
                      style={{
                        background: "none",
                        border: "1px solid #1a2035",
                        borderRadius: 4,
                        color: "#6b7394",
                        fontSize: 10,
                        padding: "3px 8px",
                        cursor: "pointer",
                        fontFamily: "'JetBrains Mono', monospace",
                      }}
                    >
                      ?
                    </button>
                  </div>
                )}
              </div>

              {/* Vol info tooltip */}
              {showVolInfo && stats && rv.rv30 != null && (
                <div
                  style={{
                    background: "#0a0e17",
                    border: "1px solid #1a2035",
                    borderRadius: 6,
                    padding: "12px 16px",
                    marginBottom: 12,
                    fontSize: 11,
                    color: "#9e9ec0",
                    lineHeight: 1.8,
                  }}
                >
                  <div
                    style={{
                      color: "#c8cdd8",
                      fontWeight: 600,
                      marginBottom: 6,
                    }}
                  >
                    Expected moves at {rv.rv30.toFixed(1)}% annualized vol
                    (current price {stats.current.toFixed(1)} SEK)
                  </div>
                  <div>
                    Daily (1 sigma): +/-{" "}
                    {(
                      (stats.current * rv.rv30 * Math.sqrt(1 / 252)) /
                      100
                    ).toFixed(1)}{" "}
                    SEK ({(rv.rv30 / Math.sqrt(252)).toFixed(2)}%)
                  </div>
                  <div>
                    Weekly (1 sigma): +/-{" "}
                    {(
                      (stats.current * rv.rv30 * Math.sqrt(1 / 52)) /
                      100
                    ).toFixed(1)}{" "}
                    SEK ({(rv.rv30 / Math.sqrt(52)).toFixed(2)}%)
                  </div>
                  <div>
                    Monthly (1 sigma): +/-{" "}
                    {(
                      (stats.current * rv.rv30 * Math.sqrt(1 / 12)) /
                      100
                    ).toFixed(1)}{" "}
                    SEK ({(rv.rv30 / Math.sqrt(12)).toFixed(2)}%)
                  </div>
                  <div
                    style={{ marginTop: 8, fontSize: 10, color: "#6b7394" }}
                  >
                    Vol regimes: &lt;20% Low | 20-35% Normal | 35-50% Elevated |
                    &gt;50% Crisis
                  </div>
                </div>
              )}

              {/* Vol stat boxes */}
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns:
                    medianIV != null
                      ? "1fr 1fr 1fr 1fr"
                      : "1fr 1fr 1fr",
                  gap: 10,
                }}
              >
                {[
                  { label: "30-Day RV", value: rv.rv30 },
                  { label: "60-Day RV", value: rv.rv60 },
                  { label: "90-Day RV", value: rv.rv90 },
                ].map((item, i) => {
                  const comp = ivRvDiff(item.value);
                  return (
                    <div key={i} style={statBox}>
                      <div
                        style={{
                          fontSize: 9,
                          color: "#6b7394",
                          textTransform: "uppercase",
                          letterSpacing: 1,
                          marginBottom: 2,
                        }}
                      >
                        {item.label}
                      </div>
                      <div
                        style={{
                          fontSize: 18,
                          fontWeight: 700,
                          color:
                            item.value != null
                              ? volRegime(item.value).color
                              : "#3a4060",
                        }}
                      >
                        {item.value != null
                          ? `${item.value.toFixed(1)}%`
                          : "--"}
                      </div>
                      {comp && (
                        <div
                          style={{
                            fontSize: 9,
                            color: comp.color,
                            marginTop: 2,
                          }}
                        >
                          {comp.label}
                        </div>
                      )}
                    </div>
                  );
                })}

                {medianIV != null && (
                  <div style={statBox}>
                    <div
                      style={{
                        fontSize: 9,
                        color: "#6b7394",
                        textTransform: "uppercase",
                        letterSpacing: 1,
                        marginBottom: 2,
                      }}
                    >
                      Median IV
                    </div>
                    <div
                      style={{
                        fontSize: 18,
                        fontWeight: 700,
                        color: "#4caf50",
                      }}
                    >
                      {medianIV.toFixed(1)}%
                    </div>
                    {rv.rv30 != null && (
                      <div
                        style={{
                          fontSize: 9,
                          color:
                            medianIV > rv.rv30 ? "#ff9800" : "#4caf50",
                          marginTop: 2,
                        }}
                      >
                        {medianIV > rv.rv30 ? "+" : ""}
                        {(medianIV - rv.rv30).toFixed(1)}pp vs 30d RV
                      </div>
                    )}
                  </div>
                )}
              </div>

              {/* IV vs RV summary */}
              {rv.rv30 != null && medianIV != null && (
                <div
                  style={{
                    marginTop: 12,
                    padding: "10px 14px",
                    borderRadius: 6,
                    fontSize: 12,
                    lineHeight: 1.6,
                    background:
                      medianIV > rv.rv30
                        ? "rgba(255,152,0,0.06)"
                        : "rgba(76,175,80,0.06)",
                    border:
                      medianIV > rv.rv30
                        ? "1px solid rgba(255,152,0,0.2)"
                        : "1px solid rgba(76,175,80,0.2)",
                    color: "#c8cdd8",
                  }}
                >
                  {medianIV > rv.rv30 + 5 ? (
                    <>
                      <strong style={{ color: "#ff9800" }}>
                        Warrants are expensive
                      </strong>{" "}
                      &mdash; implied vol ({medianIV.toFixed(1)}%) is{" "}
                      {(medianIV - rv.rv30).toFixed(1)}pp above 30-day realized
                      vol ({rv.rv30.toFixed(1)}%). The market is pricing in more
                      turbulence than recent history shows.
                    </>
                  ) : medianIV < rv.rv30 - 5 ? (
                    <>
                      <strong style={{ color: "#4caf50" }}>
                        Warrants may be cheap
                      </strong>{" "}
                      &mdash; implied vol ({medianIV.toFixed(1)}%) is{" "}
                      {(rv.rv30 - medianIV).toFixed(1)}pp below 30-day realized
                      vol ({rv.rv30.toFixed(1)}%). During escalating volatility,
                      this gap suggests warrant pricing hasn&rsquo;t caught up.
                    </>
                  ) : (
                    <>
                      <strong style={{ color: "#6b7394" }}>
                        Fair pricing
                      </strong>{" "}
                      &mdash; implied vol ({medianIV.toFixed(1)}%) is close to
                      30-day realized vol ({rv.rv30.toFixed(1)}%). Warrants are
                      priced roughly in line with recent realized moves.
                    </>
                  )}
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
