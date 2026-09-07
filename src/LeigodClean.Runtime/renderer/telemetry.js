'use strict';

(function exposeTelemetry(root, factory) {
  const telemetry = Object.freeze(factory());
  if (typeof module === 'object' && module.exports) {
    module.exports = telemetry;
    return;
  }
  root.leigodCleanTelemetry = telemetry;
})(typeof globalThis === 'object' ? globalThis : this, () => {
  const RANGES = Object.freeze({
    minute: 60_000,
    fiveMinutes: 5 * 60_000,
    fifteenMinutes: 15 * 60_000,
  });
  const MAX_AGE_MS = RANGES.fifteenMinutes;
  const MAX_POINTS = 480;

  function normalizedSample(sample) {
    const at = Number(sample?.at);
    const value = Number(sample?.value);
    if (!Number.isFinite(at) || at <= 0 || !Number.isFinite(value) || value < 0) {
      return null;
    }
    return { at, value };
  }

  function appendSample(series, sample, options = {}) {
    if (!Array.isArray(series)) {
      throw new TypeError('A telemetry series array is required.');
    }
    const next = normalizedSample(sample);
    if (!next) {
      return series;
    }
    const minimumIntervalMs = Math.max(0, Number(options.minimumIntervalMs) || 1_500);
    const maxAgeMs = Math.max(1_000, Number(options.maxAgeMs) || MAX_AGE_MS);
    const maxPoints = Math.max(2, Math.floor(Number(options.maxPoints) || MAX_POINTS));
    const previous = series.at(-1);
    if (previous && next.at < previous.at) {
      return series;
    }
    if (previous && next.at - previous.at < minimumIntervalMs) {
      previous.at = next.at;
      previous.value = next.value;
    } else {
      series.push(next);
    }
    const cutoff = next.at - maxAgeMs;
    while (series.length > 0 && series[0].at < cutoff) {
      series.shift();
    }
    if (series.length > maxPoints) {
      series.splice(0, series.length - maxPoints);
    }
    return series;
  }

  function visibleSamples(series, rangeMs, now = Date.now()) {
    if (!Array.isArray(series) || series.length === 0) {
      return [];
    }
    const duration = Math.max(1_000, Number(rangeMs) || RANGES.fiveMinutes);
    const cutoff = Number(now) - duration;
    const firstVisible = series.findIndex((sample) => sample.at >= cutoff);
    if (firstVisible < 0) {
      return [];
    }
    const start = Math.max(0, firstVisible - 1);
    return series.slice(start).filter((sample) => sample.at <= now);
  }

  function summarize(samples) {
    if (!Array.isArray(samples) || samples.length === 0) {
      return null;
    }
    let minimum = Number.POSITIVE_INFINITY;
    let maximum = Number.NEGATIVE_INFINITY;
    let total = 0;
    for (const sample of samples) {
      minimum = Math.min(minimum, sample.value);
      maximum = Math.max(maximum, sample.value);
      total += sample.value;
    }
    return {
      current: samples.at(-1).value,
      average: total / samples.length,
      minimum,
      maximum,
    };
  }

  function chartDomain(samples, metric) {
    const summary = summarize(samples);
    if (!summary) {
      return { minimum: 0, maximum: 1 };
    }
    if (metric === 'loss') {
      return {
        minimum: 0,
        maximum: Math.max(1, summary.maximum * 1.2),
      };
    }
    const span = summary.maximum - summary.minimum;
    const padding = Math.max(5, span * 0.18, summary.maximum * 0.04);
    return {
      minimum: Math.max(0, summary.minimum - padding),
      maximum: summary.maximum + padding,
    };
  }

  function createChartModel(series, options = {}) {
    const now = Number(options.now) || Date.now();
    const rangeMs = Math.max(1_000, Number(options.rangeMs) || RANGES.fiveMinutes);
    const width = Math.max(1, Number(options.width) || 1);
    const height = Math.max(1, Number(options.height) || 1);
    const metric = options.metric === 'loss' ? 'loss' : 'delay';
    const samples = visibleSamples(series, rangeMs, now);
    const summary = summarize(samples);
    const domain = chartDomain(samples, metric);
    const domainSpan = Math.max(Number.EPSILON, domain.maximum - domain.minimum);
    const cutoff = now - rangeMs;
    const points = samples.map((sample) => ({
      x: Math.max(0, Math.min(width, ((sample.at - cutoff) / rangeMs) * width)),
      y: Math.max(0, Math.min(height,
        height - (((sample.value - domain.minimum) / domainSpan) * height))),
      at: sample.at,
      value: sample.value,
    }));
    return { domain, points, samples, summary };
  }

  return {
    MAX_AGE_MS,
    MAX_POINTS,
    RANGES,
    appendSample,
    createChartModel,
    summarize,
    visibleSamples,
  };
});
