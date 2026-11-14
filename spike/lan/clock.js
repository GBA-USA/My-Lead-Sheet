export const WINDOW = 32;
export const FASTEST = 8;

export function percentile(values, p) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
}

export function sample(t0, band, t1) {
  return { offset: band - (t0 + t1) / 2, rtt: t1 - t0 };
}

export function estimate(window) {
  if (window.length < FASTEST) return null;
  const fastest = [...window].sort((a, b) => a.rtt - b.rtt).slice(0, FASTEST).map((s) => s.offset).sort((a, b) => a - b);
  return { offset: (fastest[FASTEST / 2 - 1] + fastest[FASTEST / 2]) / 2, spread: fastest[FASTEST - 1] - fastest[0] };
}

export function createClock() {
  const window = [];
  const rtts = [];
  const spreads = [];
  return {
    add(t0, band, t1) {
      const s = sample(t0, band, t1);
      window.push(s);
      if (window.length > WINDOW) window.shift();
      rtts.push(s.rtt);
      const e = estimate(window);
      if (e) spreads.push(e.spread);
      return e;
    },
    summary() {
      const round = (v) => (v === null ? null : Math.round(v * 1000) / 1000);
      const rttP99 = percentile(rtts, 99);
      return {
        samples: rtts.length,
        rttP50Ms: round(percentile(rtts, 50)),
        rttP99Ms: round(rttP99),
        oneWayP99Ms: round(rttP99 === null ? null : rttP99 / 2),
        spreadP95Ms: round(percentile(spreads, 95)),
        spreadMaxMs: round(spreads.length ? Math.max(...spreads) : null),
        offsetMs: round(estimate(window)?.offset ?? null),
      };
    },
  };
}
