// ── Black-Scholes math ─────────────────────────────────────────────────────

export const cdf = (x) => {
  const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741;
  const a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
  const sign = x < 0 ? -1 : 1;
  const t = 1.0 / (1.0 + p * Math.abs(x) / Math.SQRT2);
  const y = 1.0 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x / 2);
  return 0.5 * (1.0 + sign * y);
};

export const npdf = (x) => Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);

export const bsPut = (S, K, T, r, sigma) => {
  if (T <= 0) return Math.max(K - S, 0);
  const d1 = (Math.log(S / K) + (r + sigma * sigma / 2) * T) / (sigma * Math.sqrt(T));
  const d2 = d1 - sigma * Math.sqrt(T);
  return K * Math.exp(-r * T) * cdf(-d2) - S * cdf(-d1);
};

export const bsCall = (S, K, T, r, sigma) => {
  if (T <= 0) return Math.max(S - K, 0);
  const d1 = (Math.log(S / K) + (r + sigma * sigma / 2) * T) / (sigma * Math.sqrt(T));
  const d2 = d1 - sigma * Math.sqrt(T);
  return S * cdf(d1) - K * Math.exp(-r * T) * cdf(d2);
};

export const bsCall1Sigma = (S, K, T, r, sigma) => {
  if (T <= 0) return Math.max(S - K, 0);
  const v = sigma * Math.sqrt(T);
  const d2 = (Math.log(S / K) + (r - sigma * sigma / 2) * T) / v;
  const norm = cdf(1) - cdf(-1);
  const a = Math.max(-1, -d2);
  if (a >= 1) return 0;
  return (S * (cdf(1 - v) - cdf(a - v)) - K * Math.exp(-r * T) * (cdf(1) - cdf(a))) / norm;
};

export const bsPut1Sigma = (S, K, T, r, sigma) => {
  if (T <= 0) return Math.max(K - S, 0);
  const v = sigma * Math.sqrt(T);
  const d2 = (Math.log(S / K) + (r - sigma * sigma / 2) * T) / v;
  const norm = cdf(1) - cdf(-1);
  const b = Math.min(1, -d2);
  if (b <= -1) return 0;
  return (K * Math.exp(-r * T) * (cdf(b) - cdf(-1)) - S * (cdf(b - v) - cdf(-1 - v))) / norm;
};

export const bsVega = (S, K, T, r, sigma) => {
  const d1 = (Math.log(S / K) + (r + sigma * sigma / 2) * T) / (sigma * Math.sqrt(T));
  return S * Math.sqrt(T) * npdf(d1);
};

export const solveIV = (marketPrice, S, K, T, r, optionType = "put") => {
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

export const LONG_MONTHS = "ABCDEFGHIJKL";
export const SHORT_MONTHS = "MNOPQRSTUVWX";

export const thirdFriday = (year, month) => {
  const first = new Date(year, month, 1);
  const dayOfWeek = first.getDay();
  const firstFriday = 1 + ((5 - dayOfWeek + 7) % 7);
  return new Date(year, month, firstFriday + 14);
};

export const parseWarrantExpiry = (name) => {
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
