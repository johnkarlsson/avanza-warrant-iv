import { useState, useMemo } from "react";

// Black-Scholes helper functions
const cdf = (x) => {
  const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741;
  const a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
  const sign = x < 0 ? -1 : 1;
  const t = 1.0 / (1.0 + p * Math.abs(x) / Math.SQRT2);
  const y = 1.0 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x / 2);
  return 0.5 * (1.0 + sign * y);
};

const bsPut = (S, K, T, r, sigma) => {
  if (T <= 0) return Math.max(K - S, 0);
  const d1 = (Math.log(S / K) + (r + sigma * sigma / 2) * T) / (sigma * Math.sqrt(T));
  const d2 = d1 - sigma * Math.sqrt(T);
  return K * Math.exp(-r * T) * cdf(-d2) - S * cdf(-d1);
};

// Normal PDF for vega calculation
const npdf = (x) => Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);

// Vega: dPrice/dSigma (same for call and put)
const bsVega = (S, K, T, r, sigma) => {
  const d1 = (Math.log(S / K) + (r + sigma * sigma / 2) * T) / (sigma * Math.sqrt(T));
  return S * Math.sqrt(T) * npdf(d1);
};

// BS Call price (needed for call IV solving)
const bsCall = (S, K, T, r, sigma) => {
  if (T <= 0) return Math.max(S - K, 0);
  const d1 = (Math.log(S / K) + (r + sigma * sigma / 2) * T) / (sigma * Math.sqrt(T));
  const d2 = d1 - sigma * Math.sqrt(T);
  return S * cdf(d1) - K * Math.exp(-r * T) * cdf(d2);
};

// Newton-Raphson implied vol solver
const solveIV = (marketPrice, S, K, T, r, optionType = "put") => {
  const priceFn = optionType === "put" ? bsPut : bsCall;
  const intrinsic = optionType === "put" ? Math.max(K * Math.exp(-r * T) - S, 0) : Math.max(S - K * Math.exp(-r * T), 0);
  if (marketPrice < intrinsic) return { iv: null, converged: false, error: "Price below intrinsic" };
  if (marketPrice <= 0) return { iv: null, converged: false, error: "Price must be positive" };
  if (T <= 0) return { iv: null, converged: false, error: "Expiry must be in the future" };

  let sigma = 0.3; // initial guess
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
      // Fallback to bisection step
      sigma = diff > 0 ? sigma * 0.5 : sigma * 1.5;
      continue;
    }
    sigma = sigma - diff / vega;
    if (sigma <= 0.001) sigma = 0.001;
    if (sigma > 10) sigma = 10;
  }
  return { iv: sigma * 100, converged: false, steps, error: "Max iterations reached" };
};

const scenarios = [
  { label: "Mild dip", drop: 5 },
  { label: "Moderate correction", drop: 10 },
  { label: "Significant sell-off", drop: 15 },
  { label: "Severe downturn", drop: 20 },
  { label: "Near strike", drop: 25 },
  { label: "Below strike", drop: 30 },
];

export default function WarrantCalculator() {
  const [spotPrice, setSpotPrice] = useState(332.3);
  const [strike] = useState(240);
  const [parity] = useState(10);
  const [warrantPrice] = useState(0.5);
  const [vol, setVol] = useState(30);
  const [daysToExpiry, setDaysToExpiry] = useState(180);
  const [riskFreeRate] = useState(0.03);

  // IV Solver state
  const [ivSpot, setIvSpot] = useState(332.3);
  const [ivStrike, setIvStrike] = useState(240);
  const [ivMarketPrice, setIvMarketPrice] = useState(5.0);
  const [ivDays, setIvDays] = useState(180);
  const [ivRate, setIvRate] = useState(3);
  const [ivType, setIvType] = useState("put");
  const [ivResult, setIvResult] = useState(null);
  const [showSteps, setShowSteps] = useState(false);

  const runIvSolver = () => {
    const T = ivDays / 365;
    const r = ivRate / 100;
    const result = solveIV(ivMarketPrice, ivSpot, ivStrike, T, r, ivType);
    setIvResult(result);
    setShowSteps(false);
  };

  const results = useMemo(() => {
    const T = daysToExpiry / 365;
    const sigma = vol / 100;

    return scenarios.map((s) => {
      const newSpot = spotPrice * (1 - s.drop / 100);
      const putValuePerShare = bsPut(newSpot, strike, T, riskFreeRate, sigma);
      const warrantTheoretical = putValuePerShare / parity;
      const pnlPerWarrant = warrantTheoretical - warrantPrice;
      const pnlPct = (pnlPerWarrant / warrantPrice) * 100;
      const intrinsic = Math.max(strike - newSpot, 0) / parity;

      return {
        ...s,
        newSpot: newSpot.toFixed(1),
        putValue: putValuePerShare.toFixed(2),
        warrantVal: warrantTheoretical.toFixed(2),
        intrinsic: intrinsic.toFixed(2),
        pnl: pnlPerWarrant.toFixed(2),
        pnlPct: pnlPct.toFixed(0),
        profitable: pnlPerWarrant > 0,
      };
    });
  }, [spotPrice, strike, parity, warrantPrice, vol, daysToExpiry, riskFreeRate]);

  const currentPutBS = useMemo(() => {
    const T = daysToExpiry / 365;
    return bsPut(spotPrice, strike, T, riskFreeRate, vol / 100);
  }, [spotPrice, strike, daysToExpiry, riskFreeRate, vol]);

  return (
    <div style={{
      minHeight: "100vh",
      background: "#0a0e17",
      color: "#c8cdd8",
      fontFamily: "'JetBrains Mono', 'Fira Code', 'SF Mono', monospace",
      padding: "32px 24px",
    }}>
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
      `}</style>

      <div style={{ maxWidth: 920, margin: "0 auto" }}>
        {/* Header */}
        <div style={{ marginBottom: 32 }}>
          <div style={{
            display: "inline-block",
            background: "#e53935",
            color: "#fff",
            fontSize: 10,
            fontWeight: 700,
            letterSpacing: 2,
            padding: "4px 10px",
            borderRadius: 3,
            marginBottom: 12,
            textTransform: "uppercase",
          }}>PUT WARRANT</div>
          <h1 style={{
            fontFamily: "'DM Sans', sans-serif",
            fontSize: 28,
            fontWeight: 700,
            color: "#fff",
            lineHeight: 1.2,
          }}>SWE6X 240SG</h1>
          <p style={{
            fontSize: 13,
            color: "#6b7394",
            marginTop: 6,
          }}>Swedbank A · Strike 240 · Parity 10 · Black-Scholes scenario model</p>
        </div>

        {/* Current state */}
        <div style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))",
          gap: 12,
          marginBottom: 28,
        }}>
          {[
            { label: "Spot", value: `${spotPrice.toFixed(1)} SEK`, color: "#fff" },
            { label: "Strike", value: "240 SEK", color: "#e53935" },
            { label: "Warrant", value: "0.50 SEK", color: "#4fc3f7" },
            { label: "Distance to strike", value: `−${((1 - strike / spotPrice) * 100).toFixed(1)}%`, color: "#ff9800" },
            { label: "BS fair value", value: `${(currentPutBS / parity).toFixed(2)} SEK`, color: "#aaa" },
          ].map((item, i) => (
            <div key={i} style={{
              background: "#111728",
              borderRadius: 8,
              padding: "14px 16px",
              border: "1px solid #1a2035",
            }}>
              <div style={{ fontSize: 10, color: "#6b7394", letterSpacing: 1, textTransform: "uppercase", marginBottom: 4 }}>{item.label}</div>
              <div style={{ fontSize: 18, fontWeight: 600, color: item.color }}>{item.value}</div>
            </div>
          ))}
        </div>

        {/* Controls */}
        <div style={{
          background: "#111728",
          borderRadius: 10,
          padding: "20px 24px",
          marginBottom: 28,
          border: "1px solid #1a2035",
          display: "grid",
          gridTemplateColumns: "1fr 1fr 1fr",
          gap: 24,
        }}>
          <div>
            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8 }}>
              <span style={{ fontSize: 11, color: "#6b7394", textTransform: "uppercase", letterSpacing: 1 }}>Spot price</span>
              <span style={{ fontSize: 13, color: "#4fc3f7", fontWeight: 600 }}>{spotPrice.toFixed(0)} SEK</span>
            </div>
            <input type="range" min={180} max={400} step={1} value={spotPrice}
              onChange={(e) => setSpotPrice(Number(e.target.value))} />
          </div>
          <div>
            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8 }}>
              <span style={{ fontSize: 11, color: "#6b7394", textTransform: "uppercase", letterSpacing: 1 }}>Implied vol</span>
              <span style={{ fontSize: 13, color: "#4fc3f7", fontWeight: 600 }}>{vol}%</span>
            </div>
            <input type="range" min={10} max={80} step={1} value={vol}
              onChange={(e) => setVol(Number(e.target.value))} />
          </div>
          <div>
            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8 }}>
              <span style={{ fontSize: 11, color: "#6b7394", textTransform: "uppercase", letterSpacing: 1 }}>Days to expiry</span>
              <span style={{ fontSize: 13, color: "#4fc3f7", fontWeight: 600 }}>{daysToExpiry}d</span>
            </div>
            <input type="range" min={7} max={365} step={1} value={daysToExpiry}
              onChange={(e) => setDaysToExpiry(Number(e.target.value))} />
          </div>
        </div>

        {/* Scenario table */}
        <div style={{
          background: "#111728",
          borderRadius: 10,
          border: "1px solid #1a2035",
          overflow: "hidden",
          marginBottom: 28,
        }}>
          <div style={{ padding: "16px 24px", borderBottom: "1px solid #1a2035" }}>
            <h2 style={{ fontFamily: "'DM Sans', sans-serif", fontSize: 16, fontWeight: 600, color: "#fff" }}>
              Scenario Analysis
            </h2>
            <p style={{ fontSize: 11, color: "#6b7394", marginTop: 4 }}>
              Theoretical warrant value at each Swedbank drop level (entry: 0.50 SEK)
            </p>
          </div>

          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
              <thead>
                <tr style={{ borderBottom: "1px solid #1a2035" }}>
                  {["Scenario", "Drop", "Swedbank", "Put value/share", "Intrinsic", "Warrant value", "P&L / warrant", "Return"].map((h, i) => (
                    <th key={i} style={{
                      padding: "12px 16px",
                      textAlign: i === 0 ? "left" : "right",
                      fontSize: 10,
                      color: "#6b7394",
                      textTransform: "uppercase",
                      letterSpacing: 1,
                      fontWeight: 500,
                      whiteSpace: "nowrap",
                    }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {results.map((r, i) => (
                  <tr key={i} style={{
                    borderBottom: i < results.length - 1 ? "1px solid #131a2e" : "none",
                    background: r.profitable ? "rgba(76, 175, 80, 0.04)" : "transparent",
                  }}>
                    <td style={{ padding: "12px 16px", fontWeight: 500, color: "#c8cdd8" }}>{r.label}</td>
                    <td style={{ padding: "12px 16px", textAlign: "right", color: "#e53935" }}>−{r.drop}%</td>
                    <td style={{ padding: "12px 16px", textAlign: "right", color: "#fff" }}>{r.newSpot}</td>
                    <td style={{ padding: "12px 16px", textAlign: "right", color: "#aaa" }}>{r.putValue}</td>
                    <td style={{ padding: "12px 16px", textAlign: "right", color: parseFloat(r.intrinsic) > 0 ? "#4caf50" : "#6b7394" }}>{r.intrinsic}</td>
                    <td style={{
                      padding: "12px 16px", textAlign: "right", fontWeight: 600,
                      color: parseFloat(r.warrantVal) > warrantPrice ? "#4fc3f7" : "#c8cdd8",
                    }}>{r.warrantVal} SEK</td>
                    <td style={{
                      padding: "12px 16px", textAlign: "right", fontWeight: 600,
                      color: r.profitable ? "#4caf50" : "#e53935",
                    }}>{r.profitable ? "+" : ""}{r.pnl}</td>
                    <td style={{
                      padding: "12px 16px", textAlign: "right", fontWeight: 700,
                      color: r.profitable ? "#4caf50" : "#e53935",
                    }}>{r.profitable ? "+" : ""}{r.pnlPct}%</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        {/* IV Solver Widget */}
        <div style={{
          background: "#111728",
          borderRadius: 10,
          border: "1px solid #1a2035",
          overflow: "hidden",
          marginBottom: 28,
        }}>
          <div style={{ padding: "16px 24px", borderBottom: "1px solid #1a2035" }}>
            <h2 style={{ fontFamily: "'DM Sans', sans-serif", fontSize: 16, fontWeight: 600, color: "#fff" }}>
              Implied Volatility Solver
            </h2>
            <p style={{ fontSize: 11, color: "#6b7394", marginTop: 4 }}>
              Newton-Raphson inversion — enter a market price to back out the implied vol
            </p>
          </div>

          <div style={{ padding: "20px 24px" }}>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 16, marginBottom: 16 }}>
              {[
                { label: "Spot price", value: ivSpot, setter: setIvSpot, step: 0.1 },
                { label: "Strike price", value: ivStrike, setter: setIvStrike, step: 1 },
                { label: `Market price (${ivType})`, value: ivMarketPrice, setter: setIvMarketPrice, step: 0.1 },
              ].map((field, i) => (
                <div key={i}>
                  <label style={{ fontSize: 10, color: "#6b7394", textTransform: "uppercase", letterSpacing: 1, display: "block", marginBottom: 6 }}>
                    {field.label}
                  </label>
                  <input
                    type="number"
                    value={field.value}
                    step={field.step}
                    onChange={(e) => field.setter(Number(e.target.value))}
                    style={{
                      width: "100%",
                      background: "#0a0e17",
                      border: "1px solid #1a2035",
                      borderRadius: 6,
                      padding: "10px 12px",
                      color: "#fff",
                      fontSize: 14,
                      fontFamily: "'JetBrains Mono', monospace",
                      outline: "none",
                    }}
                  />
                </div>
              ))}
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 16, marginBottom: 20 }}>
              <div>
                <label style={{ fontSize: 10, color: "#6b7394", textTransform: "uppercase", letterSpacing: 1, display: "block", marginBottom: 6 }}>
                  Days to expiry
                </label>
                <input
                  type="number"
                  value={ivDays}
                  step={1}
                  onChange={(e) => setIvDays(Number(e.target.value))}
                  style={{
                    width: "100%",
                    background: "#0a0e17",
                    border: "1px solid #1a2035",
                    borderRadius: 6,
                    padding: "10px 12px",
                    color: "#fff",
                    fontSize: 14,
                    fontFamily: "'JetBrains Mono', monospace",
                    outline: "none",
                  }}
                />
              </div>
              <div>
                <label style={{ fontSize: 10, color: "#6b7394", textTransform: "uppercase", letterSpacing: 1, display: "block", marginBottom: 6 }}>
                  Risk-free rate (%)
                </label>
                <input
                  type="number"
                  value={ivRate}
                  step={0.1}
                  onChange={(e) => setIvRate(Number(e.target.value))}
                  style={{
                    width: "100%",
                    background: "#0a0e17",
                    border: "1px solid #1a2035",
                    borderRadius: 6,
                    padding: "10px 12px",
                    color: "#fff",
                    fontSize: 14,
                    fontFamily: "'JetBrains Mono', monospace",
                    outline: "none",
                  }}
                />
              </div>
              <div>
                <label style={{ fontSize: 10, color: "#6b7394", textTransform: "uppercase", letterSpacing: 1, display: "block", marginBottom: 6 }}>
                  Option type
                </label>
                <div style={{ display: "flex", gap: 8 }}>
                  {["put", "call"].map((t) => (
                    <button key={t} onClick={() => setIvType(t)} style={{
                      flex: 1,
                      padding: "10px",
                      borderRadius: 6,
                      border: ivType === t ? "1px solid #4fc3f7" : "1px solid #1a2035",
                      background: ivType === t ? "rgba(79,195,247,0.1)" : "#0a0e17",
                      color: ivType === t ? "#4fc3f7" : "#6b7394",
                      fontSize: 13,
                      fontFamily: "'JetBrains Mono', monospace",
                      fontWeight: 600,
                      cursor: "pointer",
                      textTransform: "uppercase",
                    }}>{t}</button>
                  ))}
                </div>
              </div>
            </div>

            <button onClick={runIvSolver} style={{
              width: "100%",
              padding: "12px",
              borderRadius: 8,
              border: "none",
              background: "linear-gradient(135deg, #4fc3f7 0%, #2196f3 100%)",
              color: "#0a0e17",
              fontSize: 13,
              fontWeight: 700,
              fontFamily: "'JetBrains Mono', monospace",
              letterSpacing: 1,
              cursor: "pointer",
              textTransform: "uppercase",
            }}>Solve for implied volatility</button>

            {ivResult && (
              <div style={{ marginTop: 20 }}>
                {ivResult.converged ? (
                  <div style={{
                    background: "rgba(76,175,80,0.08)",
                    border: "1px solid rgba(76,175,80,0.25)",
                    borderRadius: 8,
                    padding: "16px 20px",
                  }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                      <div>
                        <div style={{ fontSize: 10, color: "#6b7394", textTransform: "uppercase", letterSpacing: 1, marginBottom: 4 }}>Implied Volatility</div>
                        <div style={{ fontSize: 28, fontWeight: 700, color: "#4caf50" }}>{ivResult.iv.toFixed(2)}%</div>
                      </div>
                      <div style={{ textAlign: "right" }}>
                        <div style={{ fontSize: 11, color: "#6b7394" }}>Converged in {ivResult.iterations} iteration{ivResult.iterations !== 1 ? "s" : ""}</div>
                        <div style={{ fontSize: 11, color: "#6b7394", marginTop: 2 }}>
                          ±{(ivSpot * ivResult.iv / 100 / Math.sqrt(12)).toFixed(1)} SEK/month (1σ)
                        </div>
                        <div style={{ fontSize: 11, color: "#6b7394", marginTop: 2 }}>
                          ±{(ivSpot * ivResult.iv / 100).toFixed(1)} SEK/year (1σ)
                        </div>
                      </div>
                    </div>

                    {ivResult.steps && (
                      <div style={{ marginTop: 14 }}>
                        <button onClick={() => setShowSteps(!showSteps)} style={{
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
                        }}>{showSteps ? "Hide" : "Show"} Newton-Raphson steps</button>

                        {showSteps && (
                          <div style={{ marginTop: 10, overflowX: "auto" }}>
                            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11 }}>
                              <thead>
                                <tr>
                                  {["Iter", "σ guess", "BS price", "Error", "Vega"].map((h, i) => (
                                    <th key={i} style={{
                                      padding: "6px 10px",
                                      textAlign: "right",
                                      fontSize: 9,
                                      color: "#6b7394",
                                      textTransform: "uppercase",
                                      letterSpacing: 1,
                                      borderBottom: "1px solid #1a2035",
                                    }}>{h}</th>
                                  ))}
                                </tr>
                              </thead>
                              <tbody>
                                {ivResult.steps.map((s, i) => (
                                  <tr key={i} style={{ borderBottom: "1px solid #131a2e" }}>
                                    <td style={{ padding: "5px 10px", textAlign: "right", color: "#6b7394" }}>{s.iter}</td>
                                    <td style={{ padding: "5px 10px", textAlign: "right", color: "#4fc3f7" }}>{s.sigma.toFixed(4)}%</td>
                                    <td style={{ padding: "5px 10px", textAlign: "right", color: "#c8cdd8" }}>{s.bsPrice.toFixed(6)}</td>
                                    <td style={{ padding: "5px 10px", textAlign: "right", color: Math.abs(s.diff) < 0.01 ? "#4caf50" : "#e53935" }}>{s.diff.toFixed(6)}</td>
                                    <td style={{ padding: "5px 10px", textAlign: "right", color: "#9e9ec0" }}>{s.vega.toFixed(4)}</td>
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
                  <div style={{
                    background: "rgba(229,57,53,0.08)",
                    border: "1px solid rgba(229,57,53,0.25)",
                    borderRadius: 8,
                    padding: "16px 20px",
                  }}>
                    <div style={{ fontSize: 13, color: "#e53935", fontWeight: 600 }}>Could not solve</div>
                    <div style={{ fontSize: 12, color: "#9e6060", marginTop: 4 }}>{ivResult.error || "The solver did not converge. Check that inputs are valid and the market price is above intrinsic value."}</div>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>

        {/* Key insight */}
        <div style={{
          background: "linear-gradient(135deg, #1a1040 0%, #0d1525 100%)",
          borderRadius: 10,
          padding: "20px 24px",
          border: "1px solid #2a1f5e",
          marginBottom: 28,
        }}>
          <h3 style={{ fontFamily: "'DM Sans', sans-serif", fontSize: 14, fontWeight: 600, color: "#b39ddb", marginBottom: 10 }}>
            Key dynamics to note
          </h3>
          <ul style={{ fontSize: 12, lineHeight: 1.8, color: "#9e9ec0", paddingLeft: 18 }}>
            <li><strong style={{ color: "#c8cdd8" }}>Time decay works against you</strong> — drag the days-to-expiry slider left to see how value evaporates as expiry approaches, even if the stock drops.</li>
            <li><strong style={{ color: "#c8cdd8" }}>Volatility is your friend</strong> — if implied vol spikes (crisis escalation), the warrant gains value even without a stock move. Try pushing vol to 50-60%.</li>
            <li><strong style={{ color: "#c8cdd8" }}>You don't need to hit 240</strong> — a 15-20% drop in Swedbank with elevated vol can make this warrant worth multiples of 0.50 SEK.</li>
            <li><strong style={{ color: "#c8cdd8" }}>Liquidity is the real risk</strong> — the order book is empty, so theoretical value and realizable value may diverge significantly.</li>
          </ul>
        </div>

        <div style={{ fontSize: 10, color: "#3a4060", textAlign: "center", padding: "8px 0" }}>
          Black-Scholes model · Assumes European-style exercise · Not investment advice · Actual pricing depends on market maker spreads and liquidity
        </div>
      </div>
    </div>
  );
}
