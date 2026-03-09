import { useState, useEffect, useMemo } from "react";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
  Legend,
} from "recharts";
import { solveIV, parseWarrantExpiry, LONG_MONTHS } from "./bs-math.js";

// ── Helpers ─────────────────────────────────────────────────────────────────

const localDateKey = (ts) => {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

// ── Chart data fetching ─────────────────────────────────────────────────────

const CACHE_TTL = 5 * 60 * 1000;
const cache = new Map();
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchStockChart(stockId, timePeriod, retries = 3) {
  const key = `stock:${stockId}:${timePeriod}`;
  const cached = cache.get(key);
  if (cached && Date.now() - cached.time < CACHE_TTL) return cached.data;

  let lastErr;
  for (let attempt = 0; attempt < retries; attempt++) {
    if (attempt > 0) await delay(1000 * 2 ** attempt);
    try {
      const res = await fetch(`/api/price-chart/stock/${stockId}?timePeriod=${timePeriod}&resolution=day`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      const data = (json.ohlc || [])
        .filter((d) => d.close != null)
        .map((d) => ({ ts: d.timestamp, close: d.close }));
      if (data.length === 0) throw new Error("No data points");
      cache.set(key, { data, time: Date.now() });
      return data;
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr;
}

async function fetchWarrantChart(warrantId, timePeriod, retries = 3) {
  const key = `mm:${warrantId}:${timePeriod}`;
  const cached = cache.get(key);
  if (cached && Date.now() - cached.time < CACHE_TTL) return cached.data;

  let lastErr;
  for (let attempt = 0; attempt < retries; attempt++) {
    if (attempt > 0) await delay(1000 * 2 ** attempt);
    try {
      const res = await fetch(`/api/price-chart/marketmaker/${warrantId}?timePeriod=${timePeriod}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      const mm = json.marketMaker || [];
      if (mm.length === 0) throw new Error("No market maker data");
      const data = mm
        .filter((d) => d.buy != null && d.sell != null)
        .map((d) => ({ ts: d.timestamp, mid: (d.buy + d.sell) / 2 }));
      if (data.length === 0) throw new Error("No data points");
      cache.set(key, { data, time: Date.now() });
      return data;
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr;
}

// ── Colors ──────────────────────────────────────────────────────────────────

const COLORS = ["#4fc3f7", "#ff9800", "#4caf50", "#e53935", "#ab47bc", "#26c6da", "#ffca28", "#7e57c2"];

// ── Styles ──────────────────────────────────────────────────────────────────

const cardStyle = {
  background: "#111728",
  borderRadius: 10,
  border: "1px solid #1a2035",
  overflow: "hidden",
  marginBottom: 28,
};

// ── Component ───────────────────────────────────────────────────────────────

export default function IVHistoryChart({ favorites, warrantDetails, searchResults, riskFreeRate, underlyingId }) {
  const [chartData, setChartData] = useState({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [hiddenLines, setHiddenLines] = useState(new Set());

  // Build list of favorited warrants with their details
  const favWarrants = useMemo(() => {
    if (!favorites || favorites.size === 0) return [];
    return searchResults
      .filter((w) => favorites.has(w.orderbookId))
      .map((w) => {
        const d = warrantDetails[w.orderbookId];
        if (!d) return null;
        const expiry = parseWarrantExpiry(w.name);
        if (!expiry) return null;
        const strike = d.keyIndicators?.strikePrice;
        const parity = d.keyIndicators?.parity || 1;
        const underlyingOBId = d.underlying?.orderbookId || underlyingId;
        const monthLetter = w.name.split(" ")[0]?.slice(-1)?.toUpperCase();
        const isLong = LONG_MONTHS.includes(monthLetter);
        const type = isLong ? "call" : "put";
        if (!strike || !underlyingOBId) return null;
        return {
          id: w.orderbookId,
          name: w.name,
          strike,
          parity,
          expiry,
          type,
          underlyingOBId,
        };
      })
      .filter(Boolean);
  }, [favorites, searchResults, warrantDetails, underlyingId]);

  // Stable key for effect dependency (avoid refetching on same set of warrants)
  const favKey = useMemo(() => favWarrants.map((w) => w.id).sort().join(","), [favWarrants]);

  // Fetch OHLC data for each favorited warrant + their underlyings
  useEffect(() => {
    if (favWarrants.length === 0) {
      setChartData({});
      return;
    }

    let cancelled = false;

    async function load() {
      setLoading(true);
      setError(null);
      try {
        // Deduplicate underlying fetches
        const underlyingIds = [...new Set(favWarrants.map((w) => w.underlyingOBId))];

        // Fetch all underlyings (stock OHLC)
        const underlyingData = {};
        await Promise.all(
          underlyingIds.map(async (uid) => {
            try {
              underlyingData[uid] = await fetchStockChart(uid, "one_year");
            } catch (e) {
              console.error(`Failed to fetch underlying ${uid}:`, e);
            }
          })
        );

        // Fetch all warrants (market maker bid/ask history)
        const warrantData = {};
        await Promise.all(
          favWarrants.map(async (w) => {
            try {
              warrantData[w.id] = await fetchWarrantChart(w.id, "one_year");
            } catch (e) {
              console.error(`Failed to fetch warrant ${w.id}:`, e);
            }
          })
        );

        if (!cancelled) {
          setChartData({ warrants: warrantData, underlyings: underlyingData });
        }
      } catch (e) {
        if (!cancelled) setError(e.message);
      }
      if (!cancelled) setLoading(false);
    }

    load();
    return () => { cancelled = true; };
  }, [favKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // Compute IV time series for each warrant
  const ivSeries = useMemo(() => {
    if (!chartData.warrants || !chartData.underlyings) return { merged: [], names: [] };

    const allSeries = {};

    for (const w of favWarrants) {
      const wData = chartData.warrants[w.id];
      const uData = chartData.underlyings[w.underlyingOBId];
      if (!wData || !uData) continue;

      // Build timestamp->close map for underlying
      const uMap = new Map();
      for (const d of uData) {
        const dayKey = localDateKey(d.ts);
        uMap.set(dayKey, d.close);
      }

      const points = [];
      for (const d of wData) {
        const dayKey = localDateKey(d.ts);
        const uClose = uMap.get(dayKey);
        if (uClose == null) continue;

        const T = (w.expiry - d.ts) / (365 * 24 * 60 * 60 * 1000);
        if (T <= 0) continue;

        const marketPrice = d.mid * w.parity;
        if (marketPrice <= 0) continue;

        const result = solveIV(marketPrice, uClose, w.strike, T, riskFreeRate, w.type);
        if (result.converged) {
          points.push({ date: dayKey, iv: Math.round(result.iv * 10) / 10 });
        }
      }

      if (points.length > 0) {
        allSeries[w.name] = points;
      }
    }

    // Merge into single array keyed by date
    const dateMap = new Map();
    const names = Object.keys(allSeries);

    for (const name of names) {
      for (const pt of allSeries[name]) {
        if (!dateMap.has(pt.date)) dateMap.set(pt.date, { date: pt.date });
        dateMap.get(pt.date)[name] = pt.iv;
      }
    }

    const merged = [...dateMap.values()].sort((a, b) => a.date.localeCompare(b.date));
    return { merged, names };
  }, [chartData, favWarrants, riskFreeRate]);

  // ── Empty state ──
  if (!favorites || favorites.size === 0) {
    return (
      <div style={{ ...cardStyle, padding: 40, textAlign: "center", flex: 1, display: "flex", alignItems: "center", justifyContent: "center" }}>
        <div>
          <div style={{ fontSize: 40, marginBottom: 16, opacity: 0.3 }}>IV</div>
          <div style={{ color: "#6b7394", fontSize: 14, lineHeight: 1.6 }}>
            Star warrants in the search results to track their IV history
          </div>
        </div>
      </div>
    );
  }

  if (loading) {
    return (
      <div style={{ ...cardStyle, padding: 40, textAlign: "center", flex: 1, display: "flex", alignItems: "center", justifyContent: "center" }}>
        <div style={{ color: "#6b7394" }}>Loading IV history...</div>
      </div>
    );
  }

  if (error) {
    return (
      <div style={{ ...cardStyle, padding: 40, textAlign: "center", flex: 1, display: "flex", alignItems: "center", justifyContent: "center" }}>
        <div style={{ color: "#e53935" }}>Error: {error}</div>
      </div>
    );
  }

  if (ivSeries.merged.length === 0) {
    return (
      <div style={{ ...cardStyle, padding: 40, textAlign: "center", flex: 1, display: "flex", alignItems: "center", justifyContent: "center" }}>
        <div style={{ color: "#6b7394" }}>No IV data available for favorited warrants</div>
      </div>
    );
  }

  return (
    <div style={{ ...cardStyle, display: "flex", flexDirection: "column", overflow: "hidden" }}>
      <div
        style={{
          padding: "16px 24px",
          borderBottom: "1px solid #1a2035",
        }}
      >
        <h2
          style={{
            fontFamily: "'DM Sans', sans-serif",
            fontSize: 16,
            fontWeight: 600,
            color: "#fff",
            margin: 0,
          }}
        >
          Implied Volatility History
        </h2>
        <div style={{ fontSize: 11, color: "#6b7394", marginTop: 4 }}>
          {ivSeries.names.length} warrant{ivSeries.names.length !== 1 ? "s" : ""} · 1 year daily
        </div>
      </div>

      <div style={{ height: "calc(50vh - 80px)", padding: "16px 8px 8px 0" }}>
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={ivSeries.merged} margin={{ top: 8, right: 16, bottom: 8, left: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#1a2035" />
            <XAxis
              dataKey="date"
              tick={{ fill: "#6b7394", fontSize: 10 }}
              tickFormatter={(d) => {
                const dt = new Date(d);
                return dt.toLocaleDateString("en-US", { month: "short", day: "numeric" });
              }}
              minTickGap={40}
            />
            <YAxis
              tick={{ fill: "#6b7394", fontSize: 10 }}
              tickFormatter={(v) => `${v}%`}
              domain={["auto", "auto"]}
              width={50}
            />
            <Tooltip
              contentStyle={{
                background: "#111728",
                border: "1px solid #1a2035",
                borderRadius: 8,
                fontSize: 12,
                color: "#c8cdd8",
              }}
              labelFormatter={(d) => new Date(d).toLocaleDateString("sv-SE")}
              formatter={(value, name) => [`${value}%`, name]}
            />
            <Legend
              wrapperStyle={{ fontSize: 11, color: "#c8cdd8", cursor: "pointer" }}
              onClick={(e) => {
                setHiddenLines((prev) => {
                  const next = new Set(prev);
                  if (next.has(e.dataKey)) next.delete(e.dataKey);
                  else next.add(e.dataKey);
                  return next;
                });
              }}
              formatter={(value) => (
                <span style={{ color: hiddenLines.has(value) ? "#3a4060" : "#c8cdd8" }}>{value}</span>
              )}
            />
            {ivSeries.names.map((name, i) => (
              <Line
                key={name}
                type="monotone"
                dataKey={name}
                stroke={COLORS[i % COLORS.length]}
                dot={false}
                strokeWidth={1.5}
                connectNulls={false}
                hide={hiddenLines.has(name)}
              />
            ))}
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
