"""净成本 Fitness Hook：按扣除真实手续费后的年化净 Sharpe 为因子打分。

逻辑：
1. 把因子值标准化到 [-1, 1] 作为目标仓位（IC 为负的因子自动反向使用）；
2. 策略毛收益 = 仓位 × 下一根K线收益；成本 = |仓位变化| × 单边费率；
3. fitness_score = 年化净 Sharpe（越高越好，> 1 才值得进一步看）。

同时输出诊断指标（毛 Sharpe / 年化毛收益 / 年化成本 / 仓位换手），
会合并进因子 metrics，可在因子审查台看到。
"""

import numpy as np
import pandas as pd

from core.miner.registry import EvaluatorRegistry

# ===== 按你的真实费率修改这里（单边）=====
# maker 1.8bp = 0.018% = 0.00018
FEE_RATE = 0.00018

_SECONDS_PER_YEAR = 31_536_000.0  # 365 天


def _position(factor_values: pd.Series, rank_ic: float) -> pd.Series:
    """把因子值标准化到 [-1, 1]，按 IC 符号决定方向（IC<0 的因子反向使用）。"""
    f = factor_values.astype(float)
    valid = f.notna()
    if not valid.any():
        return pd.Series(0.0, index=f.index)
    std = f[valid].std()
    z = (f - f[valid].mean()) / (std if std and np.isfinite(std) and std != 0 else 1.0)
    pos = (z.clip(-3.0, 3.0) / 3.0).fillna(0.0)
    direction = 1.0 if rank_ic >= 0 else -1.0
    return direction * pos


def _annualized_sharpe(x: pd.Series) -> float:
    if len(x) < 2:
        return 0.0
    std = x.std(ddof=0)
    if not np.isfinite(std) or std == 0:
        return 0.0
    seconds = (x.index[-1] - x.index[0]).total_seconds()
    if seconds <= 0:
        return 0.0
    bars_per_year = len(x) * (_SECONDS_PER_YEAR / seconds)
    return float(x.mean() / std * np.sqrt(bars_per_year))


@EvaluatorRegistry.register_fitness_hook("my_net_cost_fitness")
def net_cost_fitness(factor_values, returns, base_metrics) -> dict:
    rank_ic = float(base_metrics.get("RankIC", 0.0))

    if not isinstance(factor_values, pd.Series) or not isinstance(returns, pd.Series) or factor_values.empty:
        return {"fitness_score": 0.0, "net_sharpe": 0.0, "gross_sharpe": 0.0,
                "position_turnover": 0.0, "annual_cost": 0.0, "annual_gross_return": 0.0}

    pos = _position(factor_values, rank_ic)
    gross = pos * returns
    cost = FEE_RATE * pos.diff().abs().fillna(0.0)
    net = gross - cost

    seconds = (net.index[-1] - net.index[0]).total_seconds()
    bars_per_year = len(net) * (_SECONDS_PER_YEAR / seconds) if seconds > 0 else 0.0

    return {
        "fitness_score": _annualized_sharpe(net),  # 主分数：年化净 Sharpe
        "net_sharpe": _annualized_sharpe(net),
        "gross_sharpe": _annualized_sharpe(gross),
        "position_turnover": float(pos.diff().abs().mean()),
        "annual_cost": float(cost.mean() * bars_per_year),
        "annual_gross_return": float(gross.mean() * bars_per_year),
        "fee_rate": FEE_RATE,
    }
