"""Vectorized advanced-math rolling operators.

Semantics are aligned with the original ``rolling().apply()`` implementations,
including NaN propagation and the min_periods window rules. The only expected
difference is floating-point summation order (~1e-15 relative) in the
least-squares / dot-product paths.
"""

import numpy as np
import pandas as pd

from core.miner.registry import OperatorRegistry

_WINDOW = np.lib.stride_tricks.sliding_window_view


def _to_series(values: np.ndarray, like: pd.Series) -> pd.Series:
    return pd.Series(values, index=like.index, name=like.name)


def _padded_windows(x: np.ndarray, window: int) -> np.ndarray:
    """Return a (len(x), window) array where row i is the trailing window at i (NaN-padded head)."""
    padded = np.concatenate([np.full(window - 1, np.nan), x])
    return _WINDOW(padded, window)


def _apply_1d(series, fn_1d):
    if isinstance(series, pd.DataFrame):
        return series.apply(fn_1d)
    return fn_1d(series)


@OperatorRegistry.register(arity=1)
def ts_frac_diff_05(series: pd.Series) -> pd.Series:
    """Fractional differencing with d=0.5 over a 20-bar rolling window."""
    d = 0.5
    window = 20
    weights = [1.0]
    for k in range(1, window):
        weights.append(-weights[-1] * (d - k + 1) / k)
    # Reverse weights to align with window elements (latest at the end)
    weights = np.array(weights[::-1])

    def frac_1d(s: pd.Series) -> pd.Series:
        x = s.to_numpy(dtype=float)
        out = np.full(len(x), np.nan)
        if len(x) >= window:
            # min_periods == window: full windows only; NaN in a window yields NaN via the dot product.
            out[window - 1:] = _WINDOW(x, window) @ weights
        return _to_series(out, s)

    return _apply_1d(series, frac_1d)


@OperatorRegistry.register(arity=1)
def ts_hurst_60(series: pd.Series) -> pd.Series:
    """Rolling Hurst Exponent estimation over 60 bars using variance ratio."""
    taus = np.array([2, 5, 10, 20])
    window = 60
    min_periods = 40

    def hurst_head(w: np.ndarray) -> float:
        """Legacy per-window computation, used only for the (<=59) leading partial windows."""
        if (~np.isnan(w)).sum() < min_periods:
            return np.nan
        variances = []
        for tau in taus:
            diffs = w[tau:] - w[:-tau]
            variances.append(np.var(diffs) if len(diffs) > 0 else np.nan)
        valid = ~np.isnan(variances) & (np.array(variances) > 0)
        if sum(valid) < 2:
            return np.nan
        poly = np.polyfit(np.log(taus[valid]), np.log(np.array(variances)[valid]), 1)
        return poly[0] / 2.0

    def hurst_1d(s: pd.Series) -> pd.Series:
        x = s.to_numpy(dtype=float)
        n = len(x)
        out = np.full(n, np.nan)
        if n < min_periods:
            return _to_series(out, s)

        # Leading partial windows (length 40-59): diffs must be taken inside the
        # window itself, so fall back to the legacy per-position computation.
        for i in range(min_periods - 1, min(window - 1, n)):
            out[i] = hurst_head(x[: i + 1])

        if n < window:
            return _to_series(out, s)

        windows = _WINDOW(x, window)  # (n-59, 60) full windows only
        valid_count = (~np.isnan(windows)).sum(axis=1)

        # Variance of tau-lag differences per window (NaN when the slice holds NaN),
        # exactly like np.var(x[tau:] - x[:-tau]) inside the old callback.
        variances = np.stack(
            [np.var(windows[:, tau:] - windows[:, :-tau], axis=1) for tau in taus],
            axis=1,
        )  # (n', 4)
        valid = ~np.isnan(variances) & (variances > 0)
        k = valid.sum(axis=1)

        log_tau = np.log(taus.astype(float))
        log_var = np.log(variances)  # may hold -inf / NaN on invalid entries
        y = np.where(valid, log_var, 0.0)
        m = valid.astype(float)
        sx = (m * log_tau).sum(axis=1)
        sy = y.sum(axis=1)
        sxx = (m * log_tau * log_tau).sum(axis=1)
        sxy = (m * log_tau * y).sum(axis=1)
        with np.errstate(divide="ignore", invalid="ignore"):
            # Closed-form OLS slope: log(Var) = 2H * log(tau) + c  =>  H = slope / 2
            slope = (k * sxy - sx * sy) / (k * sxx - sx**2)
            h = slope / 2.0
        h[(k < 2) | (valid_count < min_periods) | ~np.isfinite(h)] = np.nan
        out[window - 1:] = h
        return _to_series(out, s)

    return _apply_1d(series, hurst_1d)


@OperatorRegistry.register(arity=1)
def ts_sampen_20(series: pd.Series) -> pd.Series:
    """Rolling Sample Entropy with m=2 over a 20-bar window."""
    window = 20
    m = 2

    def sampen_1d(s: pd.Series) -> pd.Series:
        x = s.to_numpy(dtype=float)
        n = len(x)
        out = np.full(n, np.nan)
        if n < window:
            return _to_series(out, s)

        windows = _WINDOW(x, window)  # (n-19, 20); min_periods == window => full windows only
        # Legacy parity: the original built templates via range(N - m_val), which
        # drops the final template of each window; reproduced here on purpose.
        t2 = _WINDOW(windows, m, axis=1)[:, : window - m, :]        # (n', 18, 2)
        t3 = _WINDOW(windows, m + 1, axis=1)[:, : window - m - 1, :]  # (n', 17, 3)
        r = 0.2 * windows.std(axis=1)
        nan_rows = np.isnan(windows).any(axis=1)

        def pair_counts(t, r_chunk):
            # Chebyshev distance < r  <=>  every coordinate diff < r. Counted over
            # ordered template pairs, self-matches excluded (diagonal forced False).
            under = None
            for d in range(t.shape[-1]):
                col = t[:, :, d]
                cond = np.abs(col[:, :, None] - col[:, None, :]) < r_chunk[:, None, None]
                under = cond if under is None else (under & cond)
            idx = np.arange(t.shape[1])
            under[:, idx, idx] = False
            return under.sum(axis=(1, 2))

        count = len(windows)
        B = np.empty(count)
        A = np.empty(count)
        chunk = 4096
        for start in range(0, count, chunk):
            sl = slice(start, min(start + chunk, count))
            B[sl] = pair_counts(t2[sl], r[sl])
            A[sl] = pair_counts(t3[sl], r[sl])
        with np.errstate(divide="ignore", invalid="ignore"):
            vals = -np.log(A / B)
        vals[(B == 0) | (A == 0) | (r == 0) | nan_rows] = np.nan
        out[window - 1:] = vals
        return _to_series(out, s)

    return _apply_1d(series, sampen_1d)
