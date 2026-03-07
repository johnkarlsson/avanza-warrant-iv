import { useState, useMemo, useEffect, useCallback, useRef } from "react";
import HistoricalChart from "./historical-chart.jsx";

// ── Black-Scholes math ─────────────────────────────────────────────────────

const cdf = (x) => {
  const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741;
  const a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
  const sign = x < 0 ? -1 : 1;
  const t = 1.0 / (1.0 + p * Math.abs(x) / Math.SQRT2);
  const y = 1.0 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x / 2);
  return 0.5 * (1.0 + sign * y);
};

const npdf = (x) => Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);

const bsPut = (S, K, T, r, sigma) => {
  if (T <= 0) return Math.max(K - S, 0);
  const d1 = (Math.log(S / K) + (r + sigma * sigma / 2) * T) / (sigma * Math.sqrt(T));
  const d2 = d1 - sigma * Math.sqrt(T);
  return K * Math.exp(-r * T) * cdf(-d2) - S * cdf(-d1);
};

const bsCall = (S, K, T, r, sigma) => {
  if (T <= 0) return Math.max(S - K, 0);
  const d1 = (Math.log(S / K) + (r + sigma * sigma / 2) * T) / (sigma * Math.sqrt(T));
  const d2 = d1 - sigma * Math.sqrt(T);
  return S * cdf(d1) - K * Math.exp(-r * T) * cdf(d2);
};

const bsVega = (S, K, T, r, sigma) => {
  const d1 = (Math.log(S / K) + (r + sigma * sigma / 2) * T) / (sigma * Math.sqrt(T));
  return S * Math.sqrt(T) * npdf(d1);
};

const solveIV = (marketPrice, S, K, T, r, optionType = "put") => {
  const priceFn = optionType === "put" ? bsPut : bsCall;
  const intrinsic = optionType === "put"
    ? Math.max(K * Math.exp(-r * T) - S, 0)
    : Math.max(S - K * Math.exp(-r * T), 0);
  if (marketPrice < intrinsic) return { iv: null, converged: false, error: "Price below intrinsic" };
  if (marketPrice <= 0) return { iv: null, converged: false, error: "Price must be positive" };
  if (T <= 0) return { iv: null, converged: false, error: "Expiry must be in the future" };

  let sigma = 0.3;
  const maxIter = 100;
  const tol = 1e-8;
  const steps = [];

  for (let i = 0; i < maxIter; i++) {
    const price = priceFn(S, K, T, r, sigma);
    const vega = bsVega(S, K, T, r, sigma);
    const diff = price - marketPrice;
    steps.push({ iter: i + 1, sigma: sigma * 100, bsPrice: price, diff, vega });

    if (Math.abs(diff) < tol) return { iv: sigma * 100, converged: true, steps, iterations: i + 1 };
    if (vega < 1e-12) {
      sigma = diff > 0 ? sigma * 0.5 : sigma * 1.5;
      continue;
    }
    sigma = sigma - diff / vega;
    if (sigma <= 0.001) sigma = 0.001;
    if (sigma > 10) sigma = 10;
  }
  return { iv: sigma * 100, converged: false, steps, error: "Max iterations reached" };
};

// ── Warrant name parser ─────────────────────────────────────────────────────
// Name format: "SWE6O 200SG" → underlying=SWE, year=2026, month=O, strike=200, issuer=SG
// Long months: A=Jan .. L=Dec, Short months: M=Jan .. X=Dec

const LONG_MONTHS = "ABCDEFGHIJKL";
const SHORT_MONTHS = "MNOPQRSTUVWX";

const thirdFriday = (year, month) => {
  const first = new Date(year, month, 1);
  const dayOfWeek = first.getDay();
  const firstFriday = 1 + ((5 - dayOfWeek + 7) % 7);
  return new Date(year, month, firstFriday + 14);
};

const parseWarrantExpiry = (name) => {
  const parts = name.split(" ");
  if (!parts[0] || parts[0].length < 3) return null;
  const prefix = parts[0];
  const monthLetter = prefix[prefix.length - 1].toUpperCase();
  const yearDigit = parseInt(prefix[prefix.length - 2]);
  if (isNaN(yearDigit)) return null;

  let month = LONG_MONTHS.indexOf(monthLetter);
  if (month === -1) month = SHORT_MONTHS.indexOf(monthLetter);
  if (month === -1) return null;

  let year = 2020 + yearDigit;
  const now = new Date();
  if (year < now.getFullYear() - 1) year += 10;

  return thirdFriday(year, month);
};

const RESIM_WHILE_DRAGGING = true;

// ── Shared styles ───────────────────────────────────────────────────────────

const inputStyle = {
  width: "100%",
  background: "#0a0e17",
  border: "1px solid #1a2035",
  borderRadius: 6,
  padding: "10px 12px",
  color: "#fff",
  fontSize: 14,
  fontFamily: "'JetBrains Mono', monospace",
  outline: "none",
};

const labelStyle = {
  fontSize: 10,
  color: "#6b7394",
  textTransform: "uppercase",
  letterSpacing: 1,
  display: "block",
  marginBottom: 6,
};

const cardStyle = {
  background: "#111728",
  borderRadius: 10,
  border: "1px solid #1a2035",
  overflow: "hidden",
  marginBottom: 28,
};

// ── Component ───────────────────────────────────────────────────────────────

export default function WarrantCalculator() {
  const detailsRef = useRef(null);
  const scrollContainerRef = useRef(null);
  const [activePanel, setActivePanel] = useState(0);
  const [visiblePanels, setVisiblePanels] = useState(1);

  // ── Search state ──
  const [underlyings, setUnderlyings] = useState([]);
  const [underlyingSearch, setUnderlyingSearch] = useState("Swedbank A");
  const [underlyingId, setUnderlyingId] = useState("5241");
  const [direction, setDirection] = useState("short");
  const [subType, setSubType] = useState("plain_vanilla");
  const [endDate, setEndDate] = useState("");
  const [availableEndDates, setAvailableEndDates] = useState([]);
  const [sortField, setSortField] = useState("iv");
  const [sortOrder, setSortOrder] = useState("asc");
  const [searchResults, setSearchResults] = useState([]);
  const [warrantDetails, setWarrantDetails] = useState({});
  const [computedIVs, setComputedIVs] = useState({});
  const [activityScores, setActivityScores] = useState({});
  const [searching, setSearching] = useState(false);
  const [totalResults, setTotalResults] = useState(0);
  const [searchError, setSearchError] = useState(null);
  const [selectedWarrantId, setSelectedWarrantId] = useState(null);
  const [rvDist, setRvDist] = useState(null);

  // ── Calculator state ──
  const [spotPrice, setSpotPrice] = useState(332.3);
  const [strike, setStrike] = useState(240);
  const [parity, setParity] = useState(10);
  const [warrantPrice, setWarrantPrice] = useState(0.5);
  const [vol, setVol] = useState(30);
  const [daysToExpiry, setDaysToExpiry] = useState(180);
  const [totalDaysToExpiry, setTotalDaysToExpiry] = useState(180);
  const [riskFreeRate, setRiskFreeRate] = useState(0.03);
  const [calcDirection, setCalcDirection] = useState("short");
  const [warrantName, setWarrantName] = useState("");
  const [underlyingName, setUnderlyingName] = useState("");

  // ── IV Solver state ──
  const [ivSpot, setIvSpot] = useState(332.3);
  const [ivStrike, setIvStrike] = useState(240);
  const [ivMarketPrice, setIvMarketPrice] = useState(5.0);
  const [ivDays, setIvDays] = useState(180);
  const [ivRate, setIvRate] = useState(3);
  const [ivType, setIvType] = useState("put");
  const [ivResult, setIvResult] = useState(null);
  const [showSteps, setShowSteps] = useState(false);

  // ── Simulation state ──
  const [simulationData, setSimulationData] = useState(null);
  const [simTimeoutPaths, setSimTimeoutPaths] = useState(null);
  const [simTimeoutTarget, setSimTimeoutTarget] = useState(null);
  const [simulating, setSimulating] = useState(false);
  const [resimTrigger, setResimTrigger] = useState(0);
  const [showDynamicsModal, setShowDynamicsModal] = useState(false);
  const [showBSModal, setShowBSModal] = useState(false);
  const [showIVExplainer, setShowIVExplainer] = useState(false);
  const [showIVModal, setShowIVModal] = useState(false);
  const simIdRef = useRef(0);
  const lastSimTargetRef = useRef(null);
  const [activeScenario, setActiveScenario] = useState(null);
  const [needsSelection, setNeedsSelection] = useState(true);
  const [cacheLoaded, setCacheLoaded] = useState(false);

  // ── Load cache on mount ──
  useEffect(() => {
    try {
      const raw = localStorage.getItem("avanza_warrant_cache");
      if (raw) {
        const { results, details, ivs, activity, total, calc, search } = JSON.parse(raw);
        if (results) setSearchResults(results);
        if (details) setWarrantDetails(details);
        if (ivs) setComputedIVs(ivs);
        if (activity) setActivityScores(activity);
        if (total != null) setTotalResults(total);
        if (search) {
          if (search.underlyingSearch != null) setUnderlyingSearch(search.underlyingSearch);
          if (search.underlyingId != null) setUnderlyingId(search.underlyingId);
          if (search.direction != null) setDirection(search.direction);
          if (search.subType != null) setSubType(search.subType);
          if (search.endDate != null) setEndDate(search.endDate);
          if (search.sortField != null) setSortField(search.sortField);
          if (search.sortOrder != null) setSortOrder(search.sortOrder);
        }
        if (calc) {
          if (calc.selectedWarrantId != null) setSelectedWarrantId(calc.selectedWarrantId);
          if (calc.spotPrice != null) setSpotPrice(calc.spotPrice);
          if (calc.strike != null) setStrike(calc.strike);
          if (calc.parity != null) setParity(calc.parity);
          if (calc.warrantPrice != null) setWarrantPrice(calc.warrantPrice);
          if (calc.vol != null) setVol(calc.vol);
          if (calc.daysToExpiry != null) setDaysToExpiry(calc.daysToExpiry);
          if (calc.totalDaysToExpiry != null) setTotalDaysToExpiry(calc.totalDaysToExpiry);
          if (calc.calcDirection != null) setCalcDirection(calc.calcDirection);
          if (calc.warrantName != null) setWarrantName(calc.warrantName);
          if (calc.underlyingName != null) setUnderlyingName(calc.underlyingName);
          if (calc.selectedWarrantId != null) setNeedsSelection(false);
        }
      }
    } catch (e) {
      console.error("Failed to load cache:", e);
    }
    setCacheLoaded(true);
  }, []);

  // ── Save search results to cache ──
  useEffect(() => {
    if (searchResults.length === 0) return;
    try {
      const existing = JSON.parse(localStorage.getItem("avanza_warrant_cache") || "{}");
      localStorage.setItem("avanza_warrant_cache", JSON.stringify({
        ...existing,
        results: searchResults,
        details: warrantDetails,
        ivs: computedIVs,
        activity: activityScores,
        total: totalResults,
      }));
    } catch (e) {
      console.error("Failed to save search cache:", e);
    }
  }, [searchResults, warrantDetails, computedIVs, activityScores, totalResults]);

  // ── Save search params to cache ──
  useEffect(() => {
    try {
      const existing = JSON.parse(localStorage.getItem("avanza_warrant_cache") || "{}");
      localStorage.setItem("avanza_warrant_cache", JSON.stringify({
        ...existing,
        search: { underlyingSearch, underlyingId, direction, subType, endDate, sortField, sortOrder },
      }));
    } catch (e) {
      console.error("Failed to save search params cache:", e);
    }
  }, [underlyingSearch, underlyingId, direction, subType, endDate, sortField, sortOrder]);

  // ── Save calculator state to cache ──
  useEffect(() => {
    if (!selectedWarrantId) return;
    try {
      const existing = JSON.parse(localStorage.getItem("avanza_warrant_cache") || "{}");
      localStorage.setItem("avanza_warrant_cache", JSON.stringify({
        ...existing,
        calc: {
          selectedWarrantId,
          spotPrice,
          strike,
          parity,
          warrantPrice,
          vol,
          daysToExpiry,
          totalDaysToExpiry,
          calcDirection,
          warrantName,
          underlyingName,
        },
      }));
    } catch (e) {
      console.error("Failed to save calc cache:", e);
    }
  }, [selectedWarrantId, spotPrice, strike, parity, warrantPrice, vol, daysToExpiry, totalDaysToExpiry, calcDirection, warrantName, underlyingName]);

  // ── Load filter options on mount ──
  useEffect(() => {
    fetch("/api/market-warrant-filter/filter-options")
      .then((r) => r.json())
      .then((data) => {
        setUnderlyings(data.underlyingInstruments || []);
        const dates = (data.endDates || []).filter(
          (d) => d.numberOfOrderbooks > 0
        );
        setAvailableEndDates(dates);
      })
      .catch(console.error);
  }, []);

  // ── Search handler ──
  const doSearch = useCallback(async () => {
    setSearching(true);
    setSearchError(null);
    try {
      const body = {
        filter: {
          underlyingInstruments: underlyingId ? [underlyingId] : [],
          directions: direction ? [direction] : [],
          issuers: ["societe generale"],
          subTypes: subType ? [subType] : [],
          endDates: endDate ? [endDate] : [],
          categories: [],
          exposures: [],
          marketplaces: [],
        },
        offset: 0,
        limit: 50,
        sortBy: { field: "name", order: sortOrder },
      };

      const res = await fetch("/api/market-warrant-filter/", {
        method: "POST",
        headers: { "Content-Type": "application/json;charset=UTF-8" },
        body: JSON.stringify(body),
      });
      const data = await res.json();

      if (data.statusCode) {
        setSearchError(data.message || "Search failed");
        setSearching(false);
        return;
      }

      // Update available end dates from filtered response
      const dates = (data.filterOptions?.endDates || []).filter(
        (d) => d.numberOfOrderbooks > 0
      );
      setAvailableEndDates(dates);

      const warrants = data.warrants || [];
      setSearchResults(warrants);
      setTotalResults(data.totalNumberOfOrderbooks || 0);

      // Fetch details for each warrant in parallel
      const details = {};
      if (warrants.length > 0) {
        await Promise.all(
          warrants.map(async (w) => {
            try {
              const dRes = await fetch(`/api/market-guide/warrant/${w.orderbookId}`);
              const detail = await dRes.json();
              if (!detail.statusCode) details[w.orderbookId] = detail;
            } catch (e) {
              console.error(`Failed to fetch ${w.orderbookId}:`, e);
            }
          })
        );
      }
      setWarrantDetails(details);

      // Compute IVs using expiry parsed from warrant name
      const ivMap = {};
      const today = new Date();
      for (const w of warrants) {
        const d = details[w.orderbookId];
        if (!d?.keyIndicators?.strikePrice) continue;
        const expiry = parseWarrantExpiry(w.name);
        if (!expiry) continue;
        const T = (expiry - today) / (365 * 24 * 60 * 60 * 1000);
        if (T <= 0) continue;
        const S = d.underlying?.quote?.last;
        const K = d.keyIndicators.strikePrice;
        const P = d.keyIndicators.parity || 1;
        const mktPrice = (d.quote?.last || 0) * P;
        const r = riskFreeRate;
        const type = w.direction === "short" ? "put" : "call";
        if (mktPrice > 0 && S > 0) {
          const result = solveIV(mktPrice, S, K, T, r, type);
          if (result.converged) ivMap[w.orderbookId] = result.iv;
        }
      }
      setComputedIVs(ivMap);

      // Set median IV as the vol for the calculator
      const ivValues = Object.values(ivMap);
      if (ivValues.length > 0) {
        ivValues.sort((a, b) => a - b);
        const mid = Math.floor(ivValues.length / 2);
        const median =
          ivValues.length % 2 === 1
            ? ivValues[mid]
            : (ivValues[mid - 1] + ivValues[mid]) / 2;
        setVol(Math.round(median));
      }

      // Fetch activity (avg daily price changes) for each warrant
      const avgChanges = {};
      if (warrants.length > 0) {
        await Promise.all(
          warrants.map(async (w) => {
            try {
              const res = await fetch(`/api/price-chart/stock/${w.orderbookId}?timePeriod=one_month`);
              if (!res.ok) return;
              const json = await res.json();
              const ohlc = json.ohlc || [];
              if (ohlc.length === 0) return;
              const byDay = {};
              for (const p of ohlc) {
                const day = new Date(p.timestamp).toDateString();
                byDay[day] = (byDay[day] || 0) + 1;
              }
              const days = Object.keys(byDay).length;
              avgChanges[w.orderbookId] = days > 0 ? ohlc.length / days : 0;
            } catch {
              // skip
            }
          })
        );
      }
      // Percentile-normalize
      const vals = Object.values(avgChanges).sort((a, b) => a - b);
      const actMap = {};
      for (const [id, avg] of Object.entries(avgChanges)) {
        if (vals.length <= 1) {
          actMap[id] = vals.length === 1 ? 50 : 0;
        } else {
          let rank = 0;
          for (const v of vals) { if (v < avg) rank++; }
          actMap[id] = Math.round((rank / (vals.length - 1)) * 100);
        }
      }
      setActivityScores(actMap);
    } catch (e) {
      console.error("Search failed:", e);
      setSearchError(e.message);
    }
    setSearching(false);
  }, [underlyingId, direction, subType, endDate, sortField, sortOrder, riskFreeRate]);

  // ── Re-search when direction changes ──
  const directionRef = useRef(direction);
  useEffect(() => {
    if (directionRef.current !== direction) {
      directionRef.current = direction;
      if (searchResults.length > 0) doSearch();
    }
  }, [direction]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Enriched results for display ──
  const enrichedResults = useMemo(() => {
    const enriched = searchResults.map((w) => {
      const d = warrantDetails[w.orderbookId];
      return {
        ...w,
        strike: d?.keyIndicators?.strikePrice ?? null,
        parity: d?.keyIndicators?.parity ?? null,
        lastPrice: d?.quote?.last ?? null,
        spotPrice: d?.underlying?.quote?.last ?? null,
        iv: computedIVs[w.orderbookId] ?? null,
        activity: activityScores[w.orderbookId] ?? null,
        expiry: parseWarrantExpiry(w.name),
        currency: d?.listing?.currency || "SEK",
      };
    });
    if (sortField !== "name") {
      const dir = sortOrder === "asc" ? 1 : -1;
      enriched.sort((a, b) => {
        const av = a[sortField], bv = b[sortField];
        if (av == null && bv == null) return 0;
        if (av == null) return 1;
        if (bv == null) return -1;
        return (av - bv) * dir;
      });
    }
    return enriched;
  }, [searchResults, warrantDetails, computedIVs, activityScores, sortField, sortOrder]);

  // ── Median IV display ──
  const medianIV = useMemo(() => {
    const ivValues = Object.values(computedIVs);
    if (ivValues.length === 0) return null;
    ivValues.sort((a, b) => a - b);
    const mid = Math.floor(ivValues.length / 2);
    return ivValues.length % 2 === 1
      ? ivValues[mid]
      : (ivValues[mid - 1] + ivValues[mid]) / 2;
  }, [computedIVs]);

  // ── Panel navigation ──
  useEffect(() => {
    const update = () => {
      const w = window.innerWidth;
      setVisiblePanels(w >= 2024 ? 3 : w >= 1700 ? 2 : 1);
    };
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);

  const scrollToPanel = useCallback((index) => {
    const container = scrollContainerRef.current;
    if (!container || !container.children[index]) return;
    const panel = container.children[index];
    const pad = parseFloat(getComputedStyle(container).paddingLeft) || 0;
    container.scrollTo({ left: panel.offsetLeft - pad, behavior: "smooth" });
  }, []);

  const isPanelVisible = useCallback((index) => {
    const container = scrollContainerRef.current;
    if (!container || !container.children[index]) return true;
    const panel = container.children[index];
    const pad = parseFloat(getComputedStyle(container).paddingLeft) || 0;
    const panelLeft = panel.offsetLeft - pad;
    const panelRight = panelLeft + panel.offsetWidth;
    const visLeft = container.scrollLeft;
    const visRight = visLeft + container.clientWidth;
    return panelLeft >= visLeft && panelRight <= visRight;
  }, []);

  const handleContainerScroll = useCallback(() => {
    const container = scrollContainerRef.current;
    if (!container) return;
    const pad = parseFloat(getComputedStyle(container).paddingLeft) || 0;
    const pw = container.children[0]?.offsetWidth || 0;
    if (pw > 0) setActivePanel(Math.round((container.scrollLeft) / pw));
  }, []);

  const canGoLeft = activePanel > 0;
  const canGoRight = activePanel < 3 - visiblePanels;

  // ── Select a warrant row ──
  const selectWarrant = useCallback(
    (w) => {
      const d = warrantDetails[w.orderbookId];
      if (!d) return;

      setSelectedWarrantId(w.orderbookId);
      setNeedsSelection(false);
      setSpotPrice(d.underlying?.quote?.last || 0);
      setStrike(d.keyIndicators?.strikePrice || 0);
      setParity(d.keyIndicators?.parity || 1);
      setWarrantPrice(d.quote?.last || 0);
      setCalcDirection(w.direction);
      setWarrantName(d.name || w.name);
      setUnderlyingName(
        d.underlying?.name || w.underlyingInstrument?.name || ""
      );

      const expiry = parseWarrantExpiry(w.name);
      if (expiry) {
        const today = new Date();
        const days = Math.max(Math.round((expiry - today) / (24 * 60 * 60 * 1000)), 1);
        setTotalDaysToExpiry(days);
        setDaysToExpiry(Math.round(days * 2 / 3));
      }

      // Set IV from computed value for this warrant
      const iv = computedIVs[w.orderbookId];
      if (iv != null) {
        setVol(Math.round(iv));
      }

      // Also populate IV solver
      setIvSpot(d.underlying?.quote?.last || 0);
      setIvStrike(d.keyIndicators?.strikePrice || 0);
      setIvMarketPrice(
        (d.quote?.last || 0) * (d.keyIndicators?.parity || 1)
      );
      if (expiry) {
        const today = new Date();
        const days = Math.round((expiry - today) / (24 * 60 * 60 * 1000));
        setIvDays(Math.max(days, 1));
      }
      setIvType(w.direction === "short" ? "put" : "call");

      setTimeout(() => {
        if (!isPanelVisible(1)) scrollToPanel(1);
      }, 0);
    },
    [warrantDetails, computedIVs, scrollToPanel, isPanelVisible]
  );

  // ── IV Solver (auto-run) ──
  useEffect(() => {
    if (ivSpot > 0 && ivStrike > 0 && ivMarketPrice > 0 && ivDays > 0) {
      const T = ivDays / 365;
      const r = ivRate / 100;
      setIvResult(solveIV(ivMarketPrice, ivSpot, ivStrike, T, r, ivType));
    } else {
      setIvResult(null);
    }
  }, [ivSpot, ivStrike, ivMarketPrice, ivDays, ivRate, ivType]);

  // ── Scenario analysis ──
  const scenarios = useMemo(() => {
    const all = [
      { change: -30 },
      { change: -25 },
      { change: -20 },
      { change: -15 },
      { change: -10 },
      { change: -5 },
      { change: 5 },
      { change: 10 },
      { change: 15 },
      { change: 20 },
      { change: 25 },
      { change: 30 },
    ];
    return calcDirection === "long" ? all.slice().reverse() : all;
  }, [calcDirection]);

  const scenarioResults = useMemo(() => {
    const T = daysToExpiry / 365;
    const sigma = vol / 100;
    const priceFn = calcDirection === "short" ? bsPut : bsCall;

    return scenarios.map((s) => {
      const newSpot = spotPrice * (1 + s.change / 100);
      const optionValue = priceFn(newSpot, strike, T, riskFreeRate, sigma);
      const warrantTheoretical = optionValue / parity;
      const pnlPerWarrant = warrantTheoretical - warrantPrice;
      const pnlPct =
        warrantPrice > 0 ? (pnlPerWarrant / warrantPrice) * 100 : 0;
      const intrinsicRaw =
        calcDirection === "short"
          ? Math.max(strike - newSpot, 0)
          : Math.max(newSpot - strike, 0);
      const intrinsic = intrinsicRaw / parity;

      const daysFromNow = totalDaysToExpiry - daysToExpiry;
      const Tprob = daysFromNow / 365;
      const prob = daysFromNow <= 0 ? 0
        : (() => {
            const d2 = (Math.log(spotPrice / newSpot) + (riskFreeRate - sigma * sigma / 2) * Tprob) / (sigma * Math.sqrt(Tprob));
            return s.change < 0 ? cdf(-d2) : cdf(d2);
          })();

      return {
        ...s,
        newSpot: newSpot.toFixed(1),
        optionValue: optionValue.toFixed(2),
        warrantVal: warrantTheoretical.toFixed(2),
        intrinsic: intrinsic.toFixed(2),
        prob: (() => {
          const pct = prob * 100;
          if (pct === 0 || pct >= 0.05) return pct.toFixed(1);
          // Show enough decimals to reveal the first significant digit
          const decimals = Math.max(1, -Math.floor(Math.log10(pct)) + 1);
          return pct.toFixed(decimals);
        })(),
        pnl: pnlPerWarrant.toFixed(2),
        pnlPct: pnlPct.toFixed(0),
        profitable: pnlPerWarrant > 0,
      };
    });
  }, [
    spotPrice,
    strike,
    parity,
    warrantPrice,
    vol,
    daysToExpiry,
    totalDaysToExpiry,
    riskFreeRate,
    calcDirection,
    scenarios,
  ]);

  const currentOptionBS = useMemo(() => {
    const T = daysToExpiry / 365;
    const priceFn = calcDirection === "short" ? bsPut : bsCall;
    return priceFn(spotPrice, strike, T, riskFreeRate, vol / 100);
  }, [spotPrice, strike, daysToExpiry, riskFreeRate, vol, calcDirection]);

  const optionTypeLabel = calcDirection === "short" ? "PUT" : "CALL";
  const distToStrike = strike > 0 ? ((1 - strike / spotPrice) * 100) : 0;

  // ── Random walk simulation ──
  const simulateForScenario = useCallback((targetPrice, scenarioChange) => {
    if (scenarioChange != null) lastSimTargetRef.current = scenarioChange;

    const calendarDays = totalDaysToExpiry - daysToExpiry;
    if (calendarDays <= 0) return;

    const tradingDays = Math.round(calendarDays * 5 / 7);
    if (tradingDays <= 0) return;

    const myId = ++simIdRef.current;
    setSimulating(true);
    setSimTimeoutPaths(null);

    const sigma = vol / 100;
    const dt = 1 / 252;
    const sqrtDt = Math.sqrt(dt);
    const drift = -0.5 * sigma * sigma * dt;
    const tolerance = 0.01;

    // Generate future business day timestamps
    const timestamps = [];
    const now = new Date();
    let d = new Date(now);
    for (let i = 0; i <= tradingDays; i++) {
      if (i > 0) {
        do { d.setDate(d.getDate() + 1); } while (d.getDay() === 0 || d.getDay() === 6);
      }
      timestamps.push(new Date(d).getTime());
    }

    let totalAttempts = 0;
    const closestPaths = []; // sorted by error ascending, max 50
    let worstKeptError = Infinity;

    const runBatch = () => {
      if (simIdRef.current !== myId) return;

      for (let i = 0; i < 10000 && totalAttempts < 500000; i++, totalAttempts++) {
        const path = [spotPrice];
        let price = spotPrice;

        for (let day = 0; day < tradingDays; day++) {
          const u1 = Math.random();
          const u2 = Math.random();
          const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
          price *= Math.exp(drift + sigma * sqrtDt * z);
          path.push(price);
        }

        const err = Math.abs(price - targetPrice) / targetPrice;
        if (err <= tolerance) {
          if (simIdRef.current !== myId) return;
          setSimulationData(path.map((p, idx) => ({
            ts: timestamps[idx],
            close: p,
          })));
          setSimTimeoutPaths(null);
          setSimTimeoutTarget(null);
          setSimulating(false);
          return;
        }

        // Keep the 50 closest paths for timeout display
        if (closestPaths.length < 50 || err < worstKeptError) {
          closestPaths.push({ err, path });
          if (closestPaths.length >= 100) {
            closestPaths.sort((a, b) => a.err - b.err);
            closestPaths.length = 50;
            worstKeptError = closestPaths[49].err;
          }
        }
      }

      if (totalAttempts >= 500000) {
        if (simIdRef.current === myId) {
          closestPaths.sort((a, b) => a.err - b.err);
          closestPaths.length = Math.min(closestPaths.length, 50);
          setSimulationData(null);
          setSimTimeoutPaths(closestPaths.map(({ path }) =>
            path.map((p, idx) => ({ ts: timestamps[idx], close: p }))
          ));
          const change = lastSimTargetRef.current;
          const closestEnd = closestPaths[0].path[closestPaths[0].path.length - 1];
          const closestChange = ((closestEnd / spotPrice - 1) * 100).toFixed(1);
          setSimTimeoutTarget({
            price: targetPrice,
            change,
            closestChange: (closestChange > 0 ? "+" : "") + closestChange,
          });
          setSimulating(false);
        }
        return;
      }

      setTimeout(runBatch, 0);
    };

    setTimeout(runBatch, 0);
  }, [spotPrice, vol, totalDaysToExpiry, daysToExpiry]);

  const resimulate = useCallback(() => {
    if (lastSimTargetRef.current == null && !simulationData) return;
    const change = lastSimTargetRef.current;
    if (change == null) return;
    const target = spotPrice * (1 + change / 100);
    simulateForScenario(target);
  }, [simulateForScenario, spotPrice, simulationData]);

  useEffect(() => {
    if (resimTrigger > 0) resimulate();
  }, [resimTrigger]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Render ──
  return (
    <div
      style={{
        height: "100vh",
        overflow: "hidden",
        position: "relative",
        background: "#0a0e17",
        color: "#c8cdd8",
        fontFamily: "'JetBrains Mono', 'Fira Code', 'SF Mono', monospace",
      }}
    >
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@300;400;500;600;700&display=swap');
        @import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;700&display=swap');
        * { box-sizing: border-box; margin: 0; padding: 0; }
        input[type=range] {
          -webkit-appearance: none; appearance: none;
          width: 100%; height: 6px; border-radius: 3px;
          background: #1a2035; outline: none; cursor: pointer;
        }
        input[type=range]::-webkit-slider-thumb {
          -webkit-appearance: none; appearance: none;
          width: 18px; height: 18px; border-radius: 50%;
          background: #4fc3f7; border: 2px solid #0a0e17; cursor: pointer;
        }
        select { -webkit-appearance: none; appearance: none; }
        @keyframes sim-spin { to { transform: rotate(360deg); } }
        @keyframes bounce-up { 0%, 100% { transform: translateY(0); } 50% { transform: translateY(-10px); } }
        tr.result-row { cursor: pointer; transition: background 0.15s; }
        tr.result-row:hover { background: rgba(79,195,247,0.06) !important; }
        * { scrollbar-width: thin; scrollbar-color: #1a2035 transparent; }
        *::-webkit-scrollbar { width: 6px; height: 6px; }
        *::-webkit-scrollbar-track { background: transparent; }
        *::-webkit-scrollbar-thumb { background: #1a2035; border-radius: 3px; }
        *::-webkit-scrollbar-thumb:hover { background: #2a3050; }
        :root { --panel-count: 1; --arrow-gutter: 48px; }
        @media (min-width: 1700px) { :root { --panel-count: 2; } }
        @media (min-width: 2024px) { :root { --panel-count: 3; --arrow-gutter: 0px; } }
        .panel-container {
          display: flex;
          overflow-x: auto;
          scroll-snap-type: x mandatory;
          -webkit-overflow-scrolling: touch;
          scrollbar-width: none;
          padding-left: var(--arrow-gutter);
          padding-right: var(--arrow-gutter);
        }
        .panel-container::-webkit-scrollbar { display: none; }
        .panel {
          flex: 0 0 calc((100vw - 2 * var(--arrow-gutter)) / var(--panel-count));
          min-width: calc((100vw - 2 * var(--arrow-gutter)) / var(--panel-count));
          scroll-snap-align: start;
          height: calc(100vh - 64px);
          overflow-y: hidden;
          padding: 0 16px;
          box-sizing: border-box;
          display: flex;
          flex-direction: column;
        }
        .nav-arrow {
          position: fixed; top: 50%; transform: translateY(-50%); z-index: 100;
          width: 44px; height: 44px; border-radius: 50%;
          border: 1px solid #1a2035; background: rgba(17,23,40,0.9);
          backdrop-filter: blur(8px);
          display: flex; align-items: center; justify-content: center;
          cursor: pointer; font-size: 22px; font-weight: 300;
          transition: color 0.2s, border-color 0.2s;
        }
        .nav-arrow:hover { border-color: #4fc3f7; }
        .nav-arrow-left { left: 6px; }
        .nav-arrow-right { right: 6px; }
        @media (min-width: 2024px) { .nav-arrow { display: none; } }
      `}</style>

      {visiblePanels < 3 && (
        <>
          <button
            className="nav-arrow nav-arrow-left"
            onClick={() => canGoLeft && scrollToPanel(activePanel - 1)}
            style={{ color: canGoLeft ? "#fff" : "#3a4060" }}
          >
            &#8249;
          </button>
          <button
            className="nav-arrow nav-arrow-right"
            onClick={() => canGoRight && scrollToPanel(activePanel + 1)}
            style={{ color: canGoRight ? "#fff" : "#3a4060" }}
          >
            &#8250;
          </button>
        </>
      )}

      <div ref={scrollContainerRef} className="panel-container" onScroll={handleContainerScroll} style={{ padding: "32px 0" }}>
        <div className="panel">
        {/* ───────────── SEARCH SECTION ───────────── */}
        <div style={{ ...cardStyle, marginBottom: 28, flexShrink: 0 }}>
          <div
            style={{
              padding: "16px 24px",
              borderBottom: "1px solid #1a2035",
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
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
                Warrant Search
              </h2>
              <p style={{ fontSize: 11, color: "#6b7394", marginTop: 4 }}>
                Issuer: Societe Generale (fixed)
              </p>
            </div>
          </div>

          <div style={{ padding: "20px 24px" }}>
            {/* Row 1: Underlying, Direction, Subtype */}
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "2fr 1fr 1fr",
                gap: 16,
                marginBottom: 16,
              }}
            >
              <div>
                <label style={labelStyle}>Underlying instrument</label>
                <input
                  type="text"
                  list="underlyings-list"
                  value={underlyingSearch}
                  onChange={(e) => {
                    setUnderlyingSearch(e.target.value);
                    const match = underlyings.find(
                      (u) =>
                        u.displayName.toLowerCase() ===
                        e.target.value.toLowerCase()
                    );
                    setUnderlyingId(match ? match.value : "");
                    setSimulationData(null);
                    setSimTimeoutPaths(null);
                    setSimTimeoutTarget(null);
                    setActiveScenario(null);
                    setNeedsSelection(true);
                  }}
                  placeholder="Type to search (e.g. Swedbank A)..."
                  style={inputStyle}
                />
                <datalist id="underlyings-list">
                  {underlyings.map((u) => (
                    <option key={u.value} value={u.displayName} />
                  ))}
                </datalist>
              </div>

              <div>
                <label style={labelStyle}>Direction</label>
                <div style={{ display: "flex", gap: 6 }}>
                  {[
                    { value: "", label: "All" },
                    { value: "short", label: "Short" },
                    { value: "long", label: "Long" },
                  ].map((opt) => (
                    <button
                      key={opt.value}
                      onClick={() => {
                        if (opt.value !== direction) {
                          setDirection(opt.value);
                          setNeedsSelection(true);
                        }
                      }}
                      style={{
                        flex: 1,
                        padding: "10px 6px",
                        borderRadius: 6,
                        border:
                          direction === opt.value
                            ? "1px solid #4fc3f7"
                            : "1px solid #1a2035",
                        background:
                          direction === opt.value
                            ? "rgba(79,195,247,0.1)"
                            : "#0a0e17",
                        color:
                          direction === opt.value ? "#4fc3f7" : "#6b7394",
                        fontSize: 12,
                        fontFamily: "'JetBrains Mono', monospace",
                        fontWeight: 600,
                        cursor: "pointer",
                      }}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <label style={labelStyle}>Type</label>
                <select
                  value={subType}
                  onChange={(e) => {
                    setSubType(e.target.value);
                    setNeedsSelection(true);
                  }}
                  style={inputStyle}
                >
                  <option value="">All types</option>
                  <option value="plain_vanilla">Warrant</option>
                  <option value="turbo">Turbo</option>
                  <option value="knock_out">Knock-out</option>
                  <option value="mini_future">Mini Future</option>
                </select>
              </div>
            </div>

            {/* Row 2: End date, Sort, Order */}
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "1fr 1fr 1fr",
                gap: 16,
                marginBottom: 20,
              }}
            >
              <div>
                <label style={labelStyle}>Expiry date</label>
                <select
                  value={endDate}
                  onChange={(e) => setEndDate(e.target.value)}
                  style={inputStyle}
                >
                  <option value="">All dates</option>
                  {availableEndDates.map((d) => (
                    <option key={d.value} value={d.value}>
                      {d.displayName} ({d.numberOfOrderbooks})
                    </option>
                  ))}
                </select>
                {availableEndDates.length === 0 && (
                  <div
                    style={{
                      fontSize: 10,
                      color: "#6b7394",
                      marginTop: 4,
                    }}
                  >
                    Search first to see available dates
                  </div>
                )}
              </div>

              <div>
                <label style={labelStyle}>Sort by</label>
                <div style={{ display: "flex", gap: 6 }}>
                  {[
                    { value: "name", label: "Name" },
                    { value: "strike", label: "Strike" },
                    { value: "lastPrice", label: "Price" },
                    { value: "iv", label: "IV" },
                    { value: "activity", label: "Activity" },
                    { value: "expiry", label: "Expiry" },
                  ].map((opt) => (
                    <button
                      key={opt.value}
                      onClick={() => setSortField(opt.value)}
                      style={{
                        flex: 1,
                        padding: "10px 6px",
                        borderRadius: 6,
                        border:
                          sortField === opt.value
                            ? "1px solid #4fc3f7"
                            : "1px solid #1a2035",
                        background:
                          sortField === opt.value
                            ? "rgba(79,195,247,0.1)"
                            : "transparent",
                        color: sortField === opt.value ? "#4fc3f7" : "#6b7394",
                        cursor: "pointer",
                        fontSize: 12,
                        fontWeight: 500,
                      }}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <label style={labelStyle}>Sort order</label>
                <div style={{ display: "flex", gap: 6 }}>
                  {[
                    { value: "asc", label: "Asc" },
                    { value: "desc", label: "Desc" },
                  ].map((opt) => (
                    <button
                      key={opt.value}
                      onClick={() => setSortOrder(opt.value)}
                      style={{
                        flex: 1,
                        padding: "10px 6px",
                        borderRadius: 6,
                        border:
                          sortOrder === opt.value
                            ? "1px solid #4fc3f7"
                            : "1px solid #1a2035",
                        background:
                          sortOrder === opt.value
                            ? "rgba(79,195,247,0.1)"
                            : "#0a0e17",
                        color:
                          sortOrder === opt.value ? "#4fc3f7" : "#6b7394",
                        fontSize: 12,
                        fontFamily: "'JetBrains Mono', monospace",
                        fontWeight: 600,
                        cursor: "pointer",
                      }}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            <button
              onClick={doSearch}
              disabled={searching}
              style={{
                width: "100%",
                padding: "12px",
                borderRadius: 8,
                border: "none",
                background: searching
                  ? "#1a2035"
                  : "linear-gradient(135deg, #4fc3f7 0%, #2196f3 100%)",
                color: searching ? "#6b7394" : "#0a0e17",
                fontSize: 13,
                fontWeight: 700,
                fontFamily: "'JetBrains Mono', monospace",
                letterSpacing: 1,
                cursor: searching ? "wait" : "pointer",
                textTransform: "uppercase",
              }}
            >
              {searching ? "Searching..." : "Search warrants"}
            </button>

            {cacheLoaded && searchResults.length === 0 && !searching && (
              <div style={{ textAlign: "center", marginTop: 8, fontSize: 28, animation: "bounce-up 1s ease-in-out infinite" }}>
                👆
              </div>
            )}

            {searchError && (
              <div
                style={{
                  marginTop: 12,
                  padding: "10px 14px",
                  background: "rgba(229,57,53,0.08)",
                  border: "1px solid rgba(229,57,53,0.25)",
                  borderRadius: 6,
                  fontSize: 12,
                  color: "#e53935",
                }}
              >
                {searchError}
              </div>
            )}
          </div>
        </div>

        {/* ───────────── SEARCH RESULTS ───────────── */}
        {searchResults.length > 0 && (
          <div style={{ ...cardStyle, marginBottom: 28, flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
            <div
              style={{
                padding: "16px 24px",
                borderBottom: "1px solid #1a2035",
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                flexShrink: 0,
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
                  Results
                  <span
                    style={{
                      fontSize: 12,
                      color: "#6b7394",
                      fontWeight: 400,
                      marginLeft: 8,
                    }}
                  >
                    {searchResults.length} of {totalResults} warrants
                  </span>
                </h2>
              </div>
              {medianIV != null && (
                <div
                  style={{
                    background: "rgba(76,175,80,0.1)",
                    border: "1px solid rgba(76,175,80,0.3)",
                    borderRadius: 6,
                    padding: "8px 14px",
                    textAlign: "center",
                  }}
                >
                  <div
                    style={{
                      fontSize: 9,
                      color: "#6b7394",
                      textTransform: "uppercase",
                      letterSpacing: 1,
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
                </div>
              )}
            </div>

            <div style={{ overflow: "auto", flex: 1, minHeight: 0 }}>
              <table
                style={{
                  width: "100%",
                  borderCollapse: "collapse",
                  fontSize: 13,
                }}
              >
                <thead>
                  <tr style={{ borderBottom: "1px solid #1a2035" }}>
                    {[
                      "Name",
                      "Dir",
                      "Expiry",
                      "Underlying",
                      "Strike",
                      "(%)",
                      "Parity",
                      "Price",
                      <span key="iv-header" style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
                        IV
                        <button
                          onClick={(e) => { e.stopPropagation(); setShowIVExplainer(true); }}
                          style={{
                            background: "#1a1040",
                            border: "1px solid #2a1f5e",
                            borderRadius: 4,
                            color: "#b39ddb",
                            fontSize: 9,
                            padding: "1px 5px",
                            cursor: "pointer",
                            fontFamily: "'JetBrains Mono', monospace",
                            fontWeight: 700,
                            lineHeight: 1.3,
                          }}
                        >
                          ?
                        </button>
                      </span>,
                      "Activity",
                    ].map((h, i) => (
                      <th
                        key={i}
                        style={{
                          padding: "12px 14px",
                          textAlign: i === 0 ? "left" : "right",
                          fontSize: 10,
                          color: "#6b7394",
                          textTransform: "uppercase",
                          letterSpacing: 1,
                          fontWeight: 500,
                          whiteSpace: "nowrap",
                          position: "sticky",
                          top: 0,
                          background: "#0d1117",
                          zIndex: 1,
                        }}
                      >
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {enrichedResults.map((r, i) => (
                    <tr
                      key={r.orderbookId}
                      className="result-row"
                      onClick={() => selectWarrant(r)}
                      style={{
                        borderBottom:
                          i < enrichedResults.length - 1
                            ? "1px solid #131a2e"
                            : "none",
                        background:
                          selectedWarrantId === r.orderbookId
                            ? "rgba(79,195,247,0.08)"
                            : "transparent",
                      }}
                    >
                      <td
                        style={{
                          padding: "12px 14px",
                          fontWeight: 500,
                          color:
                            selectedWarrantId === r.orderbookId
                              ? "#4fc3f7"
                              : "#c8cdd8",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {r.name}
                        <a
                          href={`https://www.avanza.se/borshandlade-produkter/warranter-torg/om-warranten.html/${r.orderbookId}/${r.name.toLowerCase().replace(/\s+/g, "-")}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          onClick={(e) => e.stopPropagation()}
                          style={{
                            display: "inline-block",
                            marginLeft: 6,
                            padding: "1px 4px",
                            fontSize: 9,
                            lineHeight: 1,
                            border: "1px solid #1a2035",
                            borderRadius: 3,
                            color: "#6b7394",
                            textDecoration: "none",
                            verticalAlign: "middle",
                          }}
                          title="Open on Avanza"
                        >
                          <svg width="10" height="10" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M4.5 1.5H2a.5.5 0 00-.5.5v8a.5.5 0 00.5.5h8a.5.5 0 00.5-.5V7.5"/><path d="M7 1.5h3.5V5"/><path d="M5 7L10.5 1.5"/></svg>
                        </a>
                      </td>
                      <td
                        style={{
                          padding: "12px 14px",
                          textAlign: "right",
                          color:
                            r.direction === "short" ? "#e53935" : "#4caf50",
                        }}
                      >
                        {r.direction === "short" ? "Put" : "Call"}
                      </td>
                      <td
                        style={{
                          padding: "12px 14px",
                          textAlign: "right",
                          color: "#6b7394",
                          fontSize: 11,
                          whiteSpace: "nowrap",
                        }}
                      >
                        {r.expiry
                          ? `${r.expiry.getFullYear()}-${String(r.expiry.getMonth() + 1).padStart(2, "0")}-${String(r.expiry.getDate()).padStart(2, "0")}`
                          : "--"}
                      </td>
                      <td
                        style={{
                          padding: "12px 14px",
                          textAlign: "right",
                          color: "#aaa",
                        }}
                      >
                        {r.spotPrice != null
                          ? `${r.spotPrice.toFixed(1)}`
                          : "--"}
                      </td>
                      <td
                        style={{
                          padding: "12px 14px",
                          textAlign: "right",
                          color: r.strike != null && r.spotPrice != null && (
                            r.direction === "short" ? r.strike > r.spotPrice : r.strike < r.spotPrice
                          ) ? "#4caf50" : "#fff",
                          fontWeight: 500,
                        }}
                      >
                        {r.strike != null ? r.strike : "--"}
                      </td>
                      <td
                        style={{
                          padding: "12px 14px",
                          textAlign: "right",
                          fontSize: 11,
                        }}
                      >
                        {r.strike != null && r.spotPrice != null ? (() => {
                          const pct = Math.round(((r.strike - r.spotPrice) / r.spotPrice) * 100);
                          return (
                            <span style={{ color:
                              r.direction === "long" && pct >= 0 ? "#4caf50"
                              : r.direction === "short" && pct < 0 ? "#e53935"
                              : "#6b7394"
                            }}>
                              {pct >= 0 ? "+" : ""}{pct}%
                            </span>
                          );
                        })() : "--"}
                      </td>
                      <td
                        style={{
                          padding: "12px 14px",
                          textAlign: "right",
                          color: "#6b7394",
                        }}
                      >
                        {r.parity != null ? r.parity : "--"}
                      </td>
                      <td
                        style={{
                          padding: "12px 14px",
                          textAlign: "right",
                          color: "#4fc3f7",
                          fontWeight: 600,
                        }}
                      >
                        {r.lastPrice != null
                          ? `${r.lastPrice.toFixed(2)}`
                          : "--"}
                      </td>
                      <td
                        style={{
                          padding: "12px 14px",
                          textAlign: "right",
                          fontWeight: 700,
                          color:
                            r.iv != null
                              ? r.iv > 40
                                ? "#ff9800"
                                : "#4caf50"
                              : "#3a4060",
                        }}
                      >
                        {r.iv != null ? `${r.iv.toFixed(1)}%` : "--"}
                      </td>
                      <td
                        style={{
                          padding: "12px 14px",
                          textAlign: "right",
                          fontWeight: 600,
                          color:
                            r.activity != null
                              ? r.activity >= 70
                                ? "#4caf50"
                                : r.activity >= 30
                                  ? "#ff9800"
                                  : "#e53935"
                              : "#3a4060",
                        }}
                      >
                        {r.activity != null ? r.activity : "--"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        </div>

        <div className="panel" style={{ position: "relative" }}>
        {needsSelection && (
          <div style={{
            position: "absolute",
            inset: 0,
            background: "rgba(8, 11, 20, 0.85)",
            zIndex: 100,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            borderRadius: 10,
          }}>
            <span style={{
              fontSize: 28,
              fontWeight: 700,
              color: "#ffffff",
              fontFamily: "'JetBrains Mono', monospace",
              textAlign: "center",
              padding: 40,
            }}>
              Select a search result
            </span>
          </div>
        )}
        {/* ───────────── CALCULATOR HEADER ───────────── */}
        <div ref={detailsRef} style={{ marginBottom: 32, display: "flex", alignItems: "flex-start", justifyContent: "space-between", flexShrink: 0 }}>
          <div>
            <div
              style={{
                display: "inline-block",
                background:
                  calcDirection === "short" ? "#e53935" : "#4caf50",
                color: "#fff",
                fontSize: 10,
                fontWeight: 700,
                letterSpacing: 2,
                padding: "4px 10px",
                borderRadius: 3,
                marginBottom: 12,
                textTransform: "uppercase",
              }}
            >
              {optionTypeLabel} WARRANT
            </div>
            <h1
              style={{
                fontFamily: "'DM Sans', sans-serif",
                fontSize: 28,
                fontWeight: 700,
                color: "#fff",
                lineHeight: 1.2,
              }}
            >
              {warrantName || "Select a warrant above"}
              {warrantName && selectedWarrantId && (
                <a
                  href={`https://www.avanza.se/borshandlade-produkter/warranter-torg/om-warranten.html/${selectedWarrantId}/${warrantName.toLowerCase().replace(/\s+/g, "-")}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{
                    display: "inline-block",
                    marginLeft: 10,
                    padding: "2px 7px",
                    fontSize: 13,
                    lineHeight: 1,
                    border: "1px solid #1a2035",
                    borderRadius: 4,
                    color: "#6b7394",
                    textDecoration: "none",
                    verticalAlign: "middle",
                  }}
                  title="Open on Avanza"
                >
                  <svg width="14" height="14" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M4.5 1.5H2a.5.5 0 00-.5.5v8a.5.5 0 00.5.5h8a.5.5 0 00.5-.5V7.5"/><path d="M7 1.5h3.5V5"/><path d="M5 7L10.5 1.5"/></svg>
                </a>
              )}
            </h1>
            <p
              style={{
                fontSize: 13,
                color: "#6b7394",
                marginTop: 6,
              }}
            >
              {underlyingName
                ? `${underlyingName} · Strike ${strike} · Parity ${parity} · Black-Scholes scenario model`
                : "Search and click a warrant to populate the calculator"}
            </p>
          </div>
          <div style={{ display: "flex", gap: 8, flexShrink: 0, marginTop: 4 }}>
            <button
              onClick={() => setShowIVModal(true)}
              style={{
                width: 32,
                height: 32,
                borderRadius: "50%",
                border: "1px solid #2a1f5e",
                background: "#1a1040",
                color: "#b39ddb",
                fontSize: 15,
                cursor: "pointer",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
              }}
              title="IV Solver"
            >
              🔧
            </button>
            <button
              onClick={() => setShowDynamicsModal(true)}
              style={{
                width: 32,
                height: 32,
                borderRadius: "50%",
                border: "1px solid #2a1f5e",
                background: "#1a1040",
                color: "#b39ddb",
                fontSize: 16,
                fontWeight: 700,
                cursor: "pointer",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
              }}
              title="Key dynamics"
            >
              ?
            </button>
          </div>
        </div>

        {/* ───────────── STATE CARDS ───────────── */}
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))",
            gap: 12,
            marginBottom: 28,
            flexShrink: 0,
          }}
        >
          {[
            {
              label: "Spot",
              value: `${spotPrice.toFixed(1)} SEK`,
              color: "#fff",
            },
            {
              label: "Strike",
              value: `${strike} SEK`,
              sub: `${distToStrike > 0 ? "−" : "+"}${Math.abs(distToStrike).toFixed(1)}%`,
              color: "#fff",
            },
            {
              label: "Warrant",
              value: `${warrantPrice.toFixed(2)} SEK`,
              color: "#4fc3f7",
            },
            {
              label: "BS fair value",
              value: `${(currentOptionBS / parity).toFixed(2)} SEK`,
              color: "#aaa",
              onClick: () => setShowBSModal(true),
            },
          ].map((item, i) => (
            <div
              key={i}
              onClick={item.onClick}
              style={{
                background: "#111728",
                borderRadius: 8,
                padding: "14px 16px",
                border: "1px solid #1a2035",
                cursor: item.onClick ? "pointer" : undefined,
              }}
            >
              <div
                style={{
                  fontSize: 10,
                  color: "#6b7394",
                  letterSpacing: 1,
                  textTransform: "uppercase",
                  marginBottom: 4,
                }}
              >
                {item.label}
              </div>
              <div
                style={{ fontSize: 18, fontWeight: 600, color: item.color }}
              >
                {item.value}
              </div>
              {item.sub && (
                <div style={{ fontSize: 18, fontWeight: 600, color: "#6b7394", marginTop: 2 }}>
                  {item.sub}
                </div>
              )}
            </div>
          ))}
        </div>

        {/* ───────────── CONTROLS ───────────── */}
        <div
          style={{
            background: "#111728",
            borderRadius: 10,
            padding: "20px 24px",
            marginBottom: 28,
            border: "1px solid #1a2035",
            display: "grid",
            gridTemplateColumns: "1fr 1fr 1fr",
            gap: 24,
            flexShrink: 0,
          }}
        >
          <div>
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                marginBottom: 8,
              }}
            >
              <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <span
                  style={{
                    fontSize: 11,
                    color: "#6b7394",
                    textTransform: "uppercase",
                    letterSpacing: 1,
                  }}
                >
                  Implied vol
                </span>
                <button
                  onClick={() => setShowIVExplainer(true)}
                  style={{
                    background: "#1a1040",
                    border: "1px solid #2a1f5e",
                    borderRadius: 4,
                    color: "#b39ddb",
                    fontSize: 10,
                    padding: "1px 6px",
                    cursor: "pointer",
                    fontFamily: "'JetBrains Mono', monospace",
                    fontWeight: 700,
                    lineHeight: 1.4,
                  }}
                >
                  ?
                </button>
              </span>
              <span
                style={{ fontSize: 13, color: "#4fc3f7", fontWeight: 600 }}
              >
                {vol}%
              </span>
            </div>
            <input
              type="range"
              min={5}
              max={120}
              step={1}
              value={vol}
              onChange={(e) => { setVol(Number(e.target.value)); if (RESIM_WHILE_DRAGGING) setResimTrigger((n) => n + 1); }}
              onMouseUp={RESIM_WHILE_DRAGGING ? undefined : resimulate}
              onTouchEnd={RESIM_WHILE_DRAGGING ? undefined : resimulate}
            />
          </div>
          <div>
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                marginBottom: 8,
              }}
            >
              <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <span
                  style={{
                    fontSize: 11,
                    color: "#6b7394",
                    textTransform: "uppercase",
                    letterSpacing: 1,
                  }}
                >
                  Days from now
                </span>
                <span
                  onClick={() => { setDaysToExpiry(Math.max(1, daysToExpiry - 30)); setResimTrigger((n) => n + 1); }}
                  style={{
                    fontSize: 11,
                    color: "#4fc3f7",
                    cursor: "pointer",
                    opacity: 0.6,
                    userSelect: "none",
                  }}
                >
                  +30
                </span>
              </span>
              <span
                style={{ fontSize: 13, color: "#4fc3f7", fontWeight: 600 }}
              >
                {totalDaysToExpiry - daysToExpiry}d
              </span>
            </div>
            <input
              type="range"
              min={0}
              max={totalDaysToExpiry - 1}
              step={1}
              value={totalDaysToExpiry - daysToExpiry}
              onChange={(e) => { setDaysToExpiry(totalDaysToExpiry - Number(e.target.value)); if (RESIM_WHILE_DRAGGING) setResimTrigger((n) => n + 1); }}
              onMouseUp={RESIM_WHILE_DRAGGING ? undefined : resimulate}
              onTouchEnd={RESIM_WHILE_DRAGGING ? undefined : resimulate}
            />
          </div>
          <div style={{ opacity: 0.5 }}>
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                marginBottom: 8,
              }}
            >
              <span
                style={{
                  fontSize: 11,
                  color: "#6b7394",
                  textTransform: "uppercase",
                  letterSpacing: 1,
                }}
              >
                Remaining days to expiry
              </span>
              <span
                style={{ fontSize: 13, color: "#8a8a8a", fontWeight: 600 }}
              >
                {daysToExpiry}d
              </span>
            </div>
            <input
              type="range"
              min={1}
              max={totalDaysToExpiry}
              step={1}
              value={daysToExpiry}
              onChange={(e) => { setDaysToExpiry(Number(e.target.value)); if (RESIM_WHILE_DRAGGING) setResimTrigger((n) => n + 1); }}
              onMouseUp={RESIM_WHILE_DRAGGING ? undefined : resimulate}
              onTouchEnd={RESIM_WHILE_DRAGGING ? undefined : resimulate}
            />
          </div>
        </div>

        {/* ───────────── SCENARIO TABLE ───────────── */}
        <div style={{ ...cardStyle, marginBottom: 28, flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
          <div
            style={{
              padding: "16px 24px",
              borderBottom: "1px solid #1a2035",
              flexShrink: 0,
            }}
          >
            <h2
              style={{
                fontFamily: "'DM Sans', sans-serif",
                fontSize: 16,
                fontWeight: 600,
                color: "#fff",
              }}
            >
              Scenario Analysis
            </h2>
            <p style={{ fontSize: 11, color: "#6b7394", marginTop: 4 }}>
              Theoretical warrant value at each{" "}
              {underlyingName || "underlying"}{" "}
              {calcDirection === "short" ? "drop" : "rally"} level (entry:{" "}
              {warrantPrice.toFixed(2)} SEK)
            </p>
          </div>

          <div style={{ overflow: "auto", flex: 1, minHeight: 0 }}>
            <table
              style={{
                width: "100%",
                borderCollapse: "collapse",
                fontSize: 13,
                tableLayout: "fixed",
              }}
            >
              <thead>
                <tr style={{ borderBottom: "1px solid #1a2035" }}>
                  {[
                    <span>Price in <span style={{ color: "#4fc3f7" }}>{totalDaysToExpiry - daysToExpiry}d</span></span>,
                    "Change",
                    "Probability",
                    "Intrinsic",
                    "Warrant value",
                    "Return",
                  ].map((h, i) => (
                    <th
                      key={i}
                      style={{
                        padding: "12px 16px",
                        textAlign: i === 2 ? "center" : "right",
                        fontSize: 10,
                        color: "#6b7394",
                        textTransform: "uppercase",
                        letterSpacing: 1,
                        fontWeight: 500,
                        whiteSpace: "nowrap",
                        position: "sticky",
                        top: 0,
                        background: "#0d1117",
                        zIndex: 1,
                      }}
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {scenarioResults.map((r, i) => (
                  <tr
                    key={i}
                    className="result-row"
                    onClick={() => {
                      setActiveScenario(r.change);
                      simulateForScenario(parseFloat(r.newSpot), r.change);
                      setTimeout(() => {
                        if (!isPanelVisible(2)) scrollToPanel(2);
                      }, 0);
                    }}
                    style={{
                      borderBottom:
                        i < scenarioResults.length - 1
                          ? "1px solid #131a2e"
                          : "none",
                      background:
                        r.change === activeScenario
                          ? "rgba(79,195,247,0.08)"
                          : "transparent",
                    }}
                  >
                    {(() => {
                      const active = r.change === activeScenario;
                      const blue = "#4fc3f7";
                      return (
                        <>
                    <td
                      style={{
                        padding: "12px 16px",
                        textAlign: "right",
                        color: active ? blue : "#fff",
                      }}
                    >
                      {r.newSpot}
                    </td>
                    <td
                      style={{
                        padding: "12px 16px",
                        textAlign: "right",
                        color:
                          r.change < 0 ? "#e53935" : "#4caf50",
                      }}
                    >
                      {r.change > 0 ? "+" : ""}
                      {r.change}%
                    </td>
                    <td
                      style={{
                        padding: "12px 16px",
                        color: active ? blue : "#b0bec5",
                      }}
                    >
                      <span style={{ display: "flex", fontVariantNumeric: "tabular-nums", fontFamily: "monospace", fontSize: 12 }}>
                        {(() => {
                          const [int, dec] = r.prob.split(".");
                          return (
                            <>
                              <span style={{ flex: "1 1 0%", minWidth: 0, overflow: "visible", textAlign: "right" }}>{int}</span>
                              <span>.</span>
                              <span style={{ flex: "1 1 0%", minWidth: 0, overflow: "visible", textAlign: "left" }}>{dec}%</span>
                            </>
                          );
                        })()}
                      </span>
                    </td>
                    <td
                      style={{
                        padding: "12px 16px",
                        textAlign: "right",
                        color:
                          parseFloat(r.intrinsic) > 0
                            ? "#4caf50"
                            : "#6b7394",
                      }}
                    >
                      {r.intrinsic}
                    </td>
                    <td
                      style={{
                        padding: "12px 16px",
                        textAlign: "right",
                        fontWeight: 600,
                        color: active ? blue : "#fff",
                      }}
                    >
                      {r.warrantVal} SEK
                    </td>
                        </>
                      );
                    })()}
                    <td
                      style={{
                        padding: "12px 16px",
                        textAlign: "right",
                        fontWeight: 700,
                        color: r.profitable ? "#4caf50" : "#e53935",
                      }}
                    >
                      {r.profitable ? "+" : ""}
                      {r.pnlPct}%
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        </div>

        <div className="panel">
        {/* ───────────── HISTORICAL CHART ───────────── */}
        <HistoricalChart
          underlyingName={underlyingSearch}
          underlyingId={underlyingId}
          medianIV={medianIV}
          onRvDist={setRvDist}
          onVolClick={(v) => { setVol(v); setResimTrigger((n) => n + 1); }}
          simulationData={simulationData}
          simTimeoutPaths={simTimeoutPaths}
          simTimeoutTarget={simTimeoutTarget}
          simulating={simulating}
          direction={direction}
        />

        {/* ───────────── FOOTER ───────────── */}
        <div
          style={{
            fontSize: 10,
            color: "#3a4060",
            textAlign: "center",
            padding: "8px 0",
          }}
        >
          Black-Scholes model · Assumes European-style exercise · Not investment
          advice · Actual pricing depends on market maker spreads and liquidity
          {" · "}
          <span
            onClick={() => { localStorage.clear(); window.location.reload(); }}
            style={{ cursor: "pointer", textDecoration: "underline" }}
          >
            Clear cache
          </span>
        </div>
        </div>
      </div>

        {/* ───────────── IV SOLVER MODAL ───────────── */}
        {showIVModal && (
          <div
            onClick={() => setShowIVModal(false)}
            style={{
              position: "fixed",
              inset: 0,
              background: "rgba(0,0,0,0.6)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              zIndex: 9999,
            }}
          >
            <div
              onClick={(e) => e.stopPropagation()}
              style={{
                ...cardStyle,
                maxWidth: 600,
                width: "90%",
                maxHeight: "90vh",
                overflowY: "auto",
                position: "relative",
              }}
            >
              <button
                onClick={() => setShowIVModal(false)}
                style={{
                  position: "absolute",
                  top: 12,
                  right: 16,
                  background: "none",
                  border: "none",
                  color: "#6b7394",
                  fontSize: 20,
                  cursor: "pointer",
                  lineHeight: 1,
                  zIndex: 1,
                }}
              >
                &times;
              </button>
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
                  }}
                >
                  Implied Volatility Solver
                </h2>
                <p style={{ fontSize: 11, color: "#6b7394", marginTop: 4 }}>
                  Newton-Raphson inversion — enter a market price to back out the
                  implied vol
                </p>
              </div>

              <div style={{ padding: "20px 24px" }}>
                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: "1fr 1fr 1fr",
                    gap: 16,
                    marginBottom: 16,
                  }}
                >
                  {[
                    {
                      label: "Spot price",
                      value: ivSpot,
                      setter: setIvSpot,
                      step: 0.1,
                    },
                    {
                      label: "Strike price",
                      value: ivStrike,
                      setter: setIvStrike,
                      step: 1,
                    },
                    {
                      label: `Market price (${ivType})`,
                      value: ivMarketPrice,
                      setter: setIvMarketPrice,
                      step: 0.1,
                    },
                  ].map((field, i) => (
                    <div key={i}>
                      <label style={labelStyle}>{field.label}</label>
                      <input
                        type="number"
                        value={field.value}
                        step={field.step}
                        onChange={(e) => field.setter(Number(e.target.value))}
                        style={inputStyle}
                      />
                    </div>
                  ))}
                </div>

                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: "1fr 1fr 1fr",
                    gap: 16,
                    marginBottom: 20,
                  }}
                >
                  <div>
                    <label style={labelStyle}>Days to expiry</label>
                    <input
                      type="number"
                      value={ivDays}
                      step={1}
                      onChange={(e) => setIvDays(Number(e.target.value))}
                      style={inputStyle}
                    />
                  </div>
                  <div>
                    <label style={labelStyle}>Risk-free rate (%)</label>
                    <input
                      type="number"
                      value={ivRate}
                      step={0.1}
                      onChange={(e) => setIvRate(Number(e.target.value))}
                      style={inputStyle}
                    />
                  </div>
                  <div>
                    <label style={labelStyle}>Option type</label>
                    <div style={{ display: "flex", gap: 8 }}>
                      {["put", "call"].map((t) => (
                        <button
                          key={t}
                          onClick={() => setIvType(t)}
                          style={{
                            flex: 1,
                            padding: "10px",
                            borderRadius: 6,
                            border:
                              ivType === t
                                ? "1px solid #4fc3f7"
                                : "1px solid #1a2035",
                            background:
                              ivType === t
                                ? "rgba(79,195,247,0.1)"
                                : "#0a0e17",
                            color: ivType === t ? "#4fc3f7" : "#6b7394",
                            fontSize: 13,
                            fontFamily: "'JetBrains Mono', monospace",
                            fontWeight: 600,
                            cursor: "pointer",
                            textTransform: "uppercase",
                          }}
                        >
                          {t}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>

                {ivResult && (
                  <div style={{ marginTop: 20 }}>
                    {ivResult.converged ? (
                      <div
                        style={{
                          background: "rgba(76,175,80,0.08)",
                          border: "1px solid rgba(76,175,80,0.25)",
                          borderRadius: 8,
                          padding: "16px 20px",
                        }}
                      >
                        <div
                          style={{
                            display: "flex",
                            justifyContent: "space-between",
                            alignItems: "center",
                          }}
                        >
                          <div>
                            <div
                              style={{
                                fontSize: 10,
                                color: "#6b7394",
                                textTransform: "uppercase",
                                letterSpacing: 1,
                                marginBottom: 4,
                              }}
                            >
                              Implied Volatility
                            </div>
                            <div
                              style={{
                                fontSize: 28,
                                fontWeight: 700,
                                color: "#4caf50",
                              }}
                            >
                              {ivResult.iv.toFixed(2)}%
                            </div>
                          </div>
                          <div style={{ textAlign: "right" }}>
                            <div style={{ fontSize: 11, color: "#6b7394" }}>
                              Converged in {ivResult.iterations} iteration
                              {ivResult.iterations !== 1 ? "s" : ""}
                            </div>
                            <div
                              style={{
                                fontSize: 11,
                                color: "#6b7394",
                                marginTop: 2,
                              }}
                            >
                              ±
                              {(
                                (ivSpot * ivResult.iv) /
                                100 /
                                Math.sqrt(12)
                              ).toFixed(1)}{" "}
                              SEK/month (1 sigma)
                            </div>
                            <div
                              style={{
                                fontSize: 11,
                                color: "#6b7394",
                                marginTop: 2,
                              }}
                            >
                              ±{((ivSpot * ivResult.iv) / 100).toFixed(1)}{" "}
                              SEK/year (1 sigma)
                            </div>
                          </div>
                        </div>

                        {ivResult.steps && (
                          <div style={{ marginTop: 14 }}>
                            <button
                              onClick={() => setShowSteps(!showSteps)}
                              style={{
                                background: "none",
                                border: "1px solid #1a2035",
                                borderRadius: 4,
                                color: "#6b7394",
                                fontSize: 10,
                                padding: "4px 10px",
                                cursor: "pointer",
                                fontFamily: "'JetBrains Mono', monospace",
                                letterSpacing: 1,
                                textTransform: "uppercase",
                              }}
                            >
                              {showSteps ? "Hide" : "Show"} Newton-Raphson steps
                            </button>

                            {showSteps && (
                              <div style={{ marginTop: 10, overflowX: "auto" }}>
                                <table
                                  style={{
                                    width: "100%",
                                    borderCollapse: "collapse",
                                    fontSize: 11,
                                  }}
                                >
                                  <thead>
                                    <tr>
                                      {[
                                        "Iter",
                                        "sigma guess",
                                        "BS price",
                                        "Error",
                                        "Vega",
                                      ].map((h, i) => (
                                        <th
                                          key={i}
                                          style={{
                                            padding: "6px 10px",
                                            textAlign: "right",
                                            fontSize: 9,
                                            color: "#6b7394",
                                            textTransform: "uppercase",
                                            letterSpacing: 1,
                                            borderBottom: "1px solid #1a2035",
                                          }}
                                        >
                                          {h}
                                        </th>
                                      ))}
                                    </tr>
                                  </thead>
                                  <tbody>
                                    {ivResult.steps.map((s, i) => (
                                      <tr
                                        key={i}
                                        style={{
                                          borderBottom: "1px solid #131a2e",
                                        }}
                                      >
                                        <td
                                          style={{
                                            padding: "5px 10px",
                                            textAlign: "right",
                                            color: "#6b7394",
                                          }}
                                        >
                                          {s.iter}
                                        </td>
                                        <td
                                          style={{
                                            padding: "5px 10px",
                                            textAlign: "right",
                                            color: "#4fc3f7",
                                          }}
                                        >
                                          {s.sigma.toFixed(4)}%
                                        </td>
                                        <td
                                          style={{
                                            padding: "5px 10px",
                                            textAlign: "right",
                                            color: "#c8cdd8",
                                          }}
                                        >
                                          {s.bsPrice.toFixed(6)}
                                        </td>
                                        <td
                                          style={{
                                            padding: "5px 10px",
                                            textAlign: "right",
                                            color:
                                              Math.abs(s.diff) < 0.01
                                                ? "#4caf50"
                                                : "#e53935",
                                          }}
                                        >
                                          {s.diff.toFixed(6)}
                                        </td>
                                        <td
                                          style={{
                                            padding: "5px 10px",
                                            textAlign: "right",
                                            color: "#9e9ec0",
                                          }}
                                        >
                                          {s.vega.toFixed(4)}
                                        </td>
                                      </tr>
                                    ))}
                                  </tbody>
                                </table>
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    ) : (
                      <div
                        style={{
                          background: "rgba(229,57,53,0.08)",
                          border: "1px solid rgba(229,57,53,0.25)",
                          borderRadius: 8,
                          padding: "16px 20px",
                        }}
                      >
                        <div
                          style={{
                            fontSize: 13,
                            color: "#e53935",
                            fontWeight: 600,
                          }}
                        >
                          Could not solve
                        </div>
                        <div
                          style={{
                            fontSize: 12,
                            color: "#9e6060",
                            marginTop: 4,
                          }}
                        >
                          {ivResult.error ||
                            "The solver did not converge. Check that inputs are valid and the market price is above intrinsic value."}
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
          </div>
        )}

        {/* ───────────── KEY DYNAMICS MODAL ───────────── */}
        {showDynamicsModal && (
          <div
            onClick={() => setShowDynamicsModal(false)}
            style={{
              position: "fixed",
              inset: 0,
              background: "rgba(0,0,0,0.6)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              zIndex: 9999,
            }}
          >
            <div
              onClick={(e) => e.stopPropagation()}
              style={{
                background: "linear-gradient(135deg, #1a1040 0%, #0d1525 100%)",
                borderRadius: 12,
                padding: "28px 32px",
                border: "1px solid #2a1f5e",
                maxWidth: 520,
                width: "90%",
                position: "relative",
              }}
            >
              <button
                onClick={() => setShowDynamicsModal(false)}
                style={{
                  position: "absolute",
                  top: 12,
                  right: 16,
                  background: "none",
                  border: "none",
                  color: "#6b7394",
                  fontSize: 20,
                  cursor: "pointer",
                  lineHeight: 1,
                }}
              >
                &times;
              </button>
              <h3
                style={{
                  fontFamily: "'DM Sans', sans-serif",
                  fontSize: 16,
                  fontWeight: 600,
                  color: "#b39ddb",
                  marginBottom: 14,
                }}
              >
                Key dynamics to note
              </h3>
              <ul
                style={{
                  fontSize: 13,
                  lineHeight: 1.9,
                  color: "#9e9ec0",
                  paddingLeft: 18,
                }}
              >
                <li>
                  <strong style={{ color: "#c8cdd8" }}>
                    Time decay works against you
                  </strong>{" "}
                  — drag the days-to-expiry slider left to see how value evaporates
                  as expiry approaches, even if the stock moves.
                </li>
                <li>
                  <strong style={{ color: "#c8cdd8" }}>
                    Volatility is your friend
                  </strong>{" "}
                  — if implied vol spikes (crisis escalation), the warrant gains
                  value even without a stock move. Try pushing vol higher.
                </li>
                <li>
                  <strong style={{ color: "#c8cdd8" }}>
                    {calcDirection === "short"
                      ? "You don't need to hit strike"
                      : "You don't need to reach strike"}
                  </strong>{" "}
                  — a significant move with elevated vol can make warrants worth
                  multiples of entry.
                </li>
                <li>
                  <strong style={{ color: "#c8cdd8" }}>
                    Liquidity is the real risk
                  </strong>{" "}
                  — the order book may be thin, so theoretical value and realizable
                  value may diverge significantly.
                </li>
              </ul>
            </div>
          </div>
        )}

        {showIVExplainer && (
          <div
            onClick={() => setShowIVExplainer(false)}
            style={{
              position: "fixed",
              inset: 0,
              background: "rgba(0,0,0,0.6)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              zIndex: 9999,
            }}
          >
            <div
              onClick={(e) => e.stopPropagation()}
              style={{
                background: "linear-gradient(135deg, #1a1040 0%, #0d1525 100%)",
                borderRadius: 12,
                padding: "28px 32px",
                border: "1px solid #2a1f5e",
                maxWidth: 520,
                width: "90%",
                position: "relative",
              }}
            >
              <button
                onClick={() => setShowIVExplainer(false)}
                style={{
                  position: "absolute",
                  top: 12,
                  right: 16,
                  background: "none",
                  border: "none",
                  color: "#6b7394",
                  fontSize: 20,
                  cursor: "pointer",
                  lineHeight: 1,
                }}
              >
                &times;
              </button>
              <h3
                style={{
                  fontFamily: "'DM Sans', sans-serif",
                  fontSize: 16,
                  fontWeight: 600,
                  color: "#b39ddb",
                  marginBottom: 14,
                }}
              >
                Implied volatility (IV)
              </h3>
              <div style={{ fontSize: 13, lineHeight: 1.9, color: "#9e9ec0" }}>
                <p style={{ marginBottom: 12 }}>
                  Implied volatility is the market&rsquo;s consensus forecast of how much the stock will move.
                  It&rsquo;s found by working backwards: given the price someone is willing to pay for an option,
                  what volatility would Black-Scholes need to produce that price?
                </p>
                <p style={{ marginBottom: 12 }}>
                  There&rsquo;s no direct formula for this &mdash; it&rsquo;s solved numerically, typically
                  using <strong style={{ color: "#c8cdd8" }}>Newton-Raphson iteration</strong>: start with a guess,
                  compute the model price, measure the error, adjust using the option&rsquo;s sensitivity to vol
                  (called <strong style={{ color: "#c8cdd8" }}>vega</strong>), and repeat until the error is negligible.
                  This usually converges in 3&ndash;5 steps.
                </p>
                <p style={{ marginBottom: 12 }}>
                  IV is quoted as an <strong style={{ color: "#c8cdd8" }}>annualized percentage</strong>. To convert
                  to shorter periods, scale by the square root of time:
                </p>
                <div style={{
                  background: "#0a0e17",
                  border: "1px solid #1a2035",
                  borderRadius: 6,
                  padding: "10px 16px",
                  marginBottom: 12,
                  fontFamily: "'JetBrains Mono', monospace",
                  fontSize: 12,
                  lineHeight: 2,
                }}>
                  <div><strong style={{ color: "#c8cdd8" }}>Monthly</strong> (1&sigma;): stock &times; IV &times; &radic;(1/12)</div>
                  <div><strong style={{ color: "#c8cdd8" }}>Weekly</strong> (1&sigma;): stock &times; IV &times; &radic;(1/52)</div>
                  <div><strong style={{ color: "#c8cdd8" }}>Daily</strong> (1&sigma;): stock &times; IV &times; &radic;(1/252)</div>
                </div>
                <p style={{ marginBottom: 0 }}>
                  A <strong style={{ color: "#c8cdd8" }}>&ldquo;1&sigma; move&rdquo;</strong> means roughly 68% of the time,
                  the actual move will be smaller than this. About 95% of the time it stays within 2&times; this range.
                </p>
              </div>
            </div>
          </div>
        )}

        {showBSModal && (
          <div
            onClick={() => setShowBSModal(false)}
            style={{
              position: "fixed",
              inset: 0,
              background: "rgba(0,0,0,0.6)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              zIndex: 9999,
            }}
          >
            <div
              onClick={(e) => e.stopPropagation()}
              style={{
                background: "linear-gradient(135deg, #1a1040 0%, #0d1525 100%)",
                borderRadius: 12,
                padding: "28px 32px",
                border: "1px solid #2a1f5e",
                maxWidth: 520,
                width: "90%",
                position: "relative",
              }}
            >
              <button
                onClick={() => setShowBSModal(false)}
                style={{
                  position: "absolute",
                  top: 12,
                  right: 16,
                  background: "none",
                  border: "none",
                  color: "#6b7394",
                  fontSize: 20,
                  cursor: "pointer",
                  lineHeight: 1,
                }}
              >
                &times;
              </button>
              <h3
                style={{
                  fontFamily: "'DM Sans', sans-serif",
                  fontSize: 16,
                  fontWeight: 600,
                  color: "#b39ddb",
                  marginBottom: 14,
                }}
              >
                Black-Scholes pricing
              </h3>
              <div style={{ fontSize: 13, lineHeight: 1.9, color: "#9e9ec0" }}>
                <p style={{ marginBottom: 12 }}>
                  An option&rsquo;s price comes from two things. <strong style={{ color: "#c8cdd8" }}>Intrinsic value</strong> is
                  the simple part: how much the option would be worth if you exercised it right now. For a put,
                  that&rsquo;s the strike price minus the stock price (or zero if the stock is above the
                  strike). <strong style={{ color: "#c8cdd8" }}>Time value</strong> is everything else &mdash; it captures the
                  probability that the stock could move favorably before expiry.
                </p>
                <p style={{ marginBottom: 12 }}>
                  <strong style={{ color: "#c8cdd8" }}>Black-Scholes</strong> calculates that probability by assuming stock prices follow a random walk, where
                  returns form a bell curve. It integrates over all possible future stock prices, weights each by
                  how likely it is, and discounts back to today. The result is a fair price for the option given
                  five inputs: the stock price, the strike, time to expiry, the risk-free rate, and
                  volatility &mdash; how much the stock is expected to bounce around.
                </p>
                <p style={{ marginBottom: 0 }}>
                  Higher volatility means fatter tails on the bell curve, which means more chance of extreme
                  moves, which means a higher option price. That&rsquo;s why vol is the single most important input.
                </p>
              </div>
            </div>
          </div>
        )}

    </div>
  );
}
