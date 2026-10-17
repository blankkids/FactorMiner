"""Robust time-series operators available to custom GP and RL searches.

Vectorized implementations: identical semantics to the original
``rolling().apply()`` versions, computed with whole-array numpy
operations instead of per-row Python callbacks.
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


@OperatorRegistry.register(arity=1)
def custom_ts_decay(series: pd.Series) -> pd.Series:
    """A 5-bar linearly weighted mean for a Series or cross-asset DataFrame."""
    weights = np.array([1, 2, 3, 4, 5], dtype=float)

    def decay_1d(s: pd.Series) -> pd.Series:
        x = s.to_numpy(dtype=float)
        n = len(x)
        out = np.full(n, np.nan)
        if n >= 5:
            # NaN inside a full window propagates to NaN, matching the float arithmetic of the lambda.
            out[4:] = (_WINDOW(x, 5) @ weights) / weights.sum()
        # Leading partial windows (length 3-4) keep the original trailing-weights semantics.
        for i in range(2, min(4, n)):
            w = x[: i + 1]
            if not np.isnan(w).any():
                out[i] = float(np.dot(w, weights[-len(w):]) / weights[-len(w):].sum())
        return _to_series(out, s)

    if isinstance(series, pd.DataFrame):
        return series.apply(decay_1d)
    return decay_1d(series)


@OperatorRegistry.register(arity=1)
def ts_zscore_20(series: pd.Series) -> pd.Series:
    """20-bar rolling Z-score, with zero-variance windows treated as missing."""
    rolling_mean = series.rolling(20, min_periods=8).mean()
    rolling_std = series.rolling(20, min_periods=8).std().replace(0, np.nan)
    return (series - rolling_mean) / rolling_std


@OperatorRegistry.register(arity=1)
def ts_delta_5(series: pd.Series) -> pd.Series:
    """Five-bar change, useful for short-horizon momentum and volume shocks."""
    return series.diff(5)


@OperatorRegistry.register(arity=1)
def ts_rank_20(series: pd.Series) -> pd.Series:
    """Percentile rank of the latest value within the trailing 20 observations."""
    window = 20
    min_periods = 8

    def rank_1d(s: pd.Series) -> pd.Series:
        x = s.to_numpy(dtype=float)
        windows = _padded_windows(x, window)
        valid = ~np.isnan(windows)
        valid_count = valid.sum(axis=1)
        last = windows[:, -1]
        less = (windows < last[:, None]) & valid
        equal = (windows == last[:, None]) & valid
        # pandas rank(method='average', pct=True) of the last element:
        # (count_less + (count_equal + 1) / 2) / count_valid
        avg_rank = less.sum(axis=1) + (equal.sum(axis=1) + 1) / 2.0
        with np.errstate(invalid="ignore"):
            out = avg_rank / valid_count
        out[valid_count < min_periods] = np.nan
        out[np.isnan(last)] = np.nan
        return _to_series(out, s)

    if isinstance(series, pd.DataFrame):
        return series.apply(rank_1d)
    return rank_1d(series)


@OperatorRegistry.register(arity=1)
def ts_volatility_20(series: pd.Series) -> pd.Series:
    """Rolling volatility of one-period percentage changes over 20 bars."""
    return series.pct_change(fill_method=None).rolling(20, min_periods=8).std()
