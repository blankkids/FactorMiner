import os
import logging
import pandas as pd
from typing import Dict, List, Any
from pathlib import Path
from core.data_feed.naming import data_path
from core.evaluation.targets import ForwardReturnTarget, target_from_config

logger = logging.getLogger(__name__)

class RealDataClient:
    def __init__(self, config: Dict):
        self.config = config
        self.data_feed_config = config.get("data_feeds", {})
        
        self.exchange = self.data_feed_config.get("exchange", "binance")
        self.instrument_type = self.data_feed_config.get("instrument_type", "futures")
        self.timeframe = self.data_feed_config.get("timeframe", "1m")
        self.pairs = self.data_feed_config.get("pairs", [])
        self.mine_periods = self.data_feed_config.get("mine_period", [])
        self.test_periods = self.data_feed_config.get("test_period", [])
        self.mining_mode = self.data_feed_config.get("mining_mode", "sequential_single")
        self.target_spec = target_from_config(config)
        
        # 预先加载好的缓存
        self._mine_data = None
        self._test_data = None
        
        # 在初始化时一次性加载数据
        self._load_all_data()

    def _load_all_data(self):
        if not self.pairs:
            logger.warning("No pairs specified in config data_feeds.")
            return

        if self.mining_mode == "sequential_single":
            primary_pair = self.pairs[0]
            if len(self.pairs) > 1:
                logger.info(f"Mining mode is 'sequential_single'. Only using the first pair: {primary_pair}")
            
            self._mine_data = self._load_periods_for_pair(primary_pair, self.mine_periods)
            self._test_data = self._load_periods_for_pair(primary_pair, self.test_periods)
            
        elif self.mining_mode == "cross_asset":
            logger.info("Mining mode is 'cross_asset'. Loading and pivoting data for all pairs.")
            
            def load_and_pivot(periods):
                dfs = []
                for pair in self.pairs:
                    df = self._load_periods_for_pair(pair, periods)
                    if not df.empty:
                        df['asset'] = pair
                        dfs.append(df)
                        
                if not dfs:
                    return None
                    
                combined = pd.concat(dfs)
                
                # Pivot into a dict of DataFrames (rows: date, cols: asset)
                pivot_dict = {}
                features = [c for c in combined.columns if c not in ['asset', 'date', 'time', 'timestamp']]
                for feature in features:
                    pivot_dict[feature] = combined.pivot(columns='asset', values=feature)
                    
                return pivot_dict
                
            self._mine_data = load_and_pivot(self.mine_periods)
            self._test_data = load_and_pivot(self.test_periods)
            
        else:
            logger.warning(f"Mining mode '{self.mining_mode}' is not fully supported yet. Falling back to sequential_single.")
            primary_pair = self.pairs[0]
            self._mine_data = self._load_periods_for_pair(primary_pair, self.mine_periods)
            self._test_data = self._load_periods_for_pair(primary_pair, self.test_periods)

    def _load_periods_for_pair(self, pair: str, periods: List[List[str]]) -> pd.DataFrame:
        if not periods:
            return pd.DataFrame()
            
        project_root = Path(os.getcwd())
        file_path = data_path(
            project_root / "data", self.exchange, pair, self.timeframe, self.instrument_type
        )
        
        if not file_path.exists():
            logger.warning(f"Data file not found: {file_path}. Attempting to download automatically...")
            
            # 收集所有需要的数据段以计算最大的时间范围
            all_periods = self.mine_periods + self.test_periods
            if not all_periods:
                logger.error(f"Cannot download {pair}: no periods specified.")
                return pd.DataFrame()
                
            all_dates = []
            for p in all_periods:
                if len(p) >= 2:
                    all_dates.append(pd.to_datetime(p[0]))
                    all_dates.append(pd.to_datetime(p[1]))
                    
            if not all_dates:
                return pd.DataFrame()
                
            start_date = min(all_dates).strftime('%Y-%m-%d')
            end_date = max(all_dates).strftime('%Y-%m-%d')
            
            from core.data_feed.data_downloader import DataDownloader
            downloader = DataDownloader()
            
            res = downloader.download_ohlcv(
                symbol=pair,
                timeframe=self.timeframe,
                start_date=start_date,
                end_date=end_date,
                trade_type=self.instrument_type
            )
            
            if not file_path.exists():
                logger.error(f"Failed to auto-download {pair} data or file still missing.")
                return pd.DataFrame()
            else:
                logger.info(f"Successfully auto-downloaded data for {pair}!")
            
        logger.info(f"Loading data from {file_path}")
        df = pd.read_feather(file_path)
        
        # 标准化索引
        if 'date' in df.columns:
            df.set_index('date', inplace=True)
        elif 'time' in df.columns:
            df.set_index('time', inplace=True)
        elif 'timestamp' in df.columns:
            df['date'] = pd.to_datetime(df['timestamp'], unit='ms')
            df.set_index('date', inplace=True)
            df.drop('timestamp', axis=1, inplace=True)
            
        if not isinstance(df.index, pd.DatetimeIndex):
            df.index = pd.to_datetime(df.index)
        if df.index.tz is not None:
            df.index = df.index.tz_localize(None)
            
        # 根据时间段进行过滤并拼接
        sliced_dfs = []
        timeframe_delta = pd.Timedelta(self.timeframe) if self.timeframe != '1w' else pd.Timedelta('7d')
        for period in periods:
            if len(period) == 2:
                start_dt, end_dt = pd.to_datetime(period[0]), pd.to_datetime(period[1])
                sliced_df = df[(df.index >= start_dt) & (df.index <= end_dt)].copy()

                # 覆盖率护栏：本地数据不足以覆盖配置区间时立即失败，
                # 绝不静默用残缺窗口计算指标（否则 IC/fitness 会严重失真）。
                expected_bars = (end_dt - start_dt) / timeframe_delta + 1
                if expected_bars >= 20 and len(sliced_df) < 0.95 * expected_bars:
                    raise RuntimeError(
                        f"本地数据不足以覆盖 {self.exchange} {pair} {self.timeframe} 的区间 "
                        f"{period[0]} ~ {period[1]}：仅 {len(sliced_df)}/{int(expected_bars)} 根K线，"
                        f"数据截止 {df.index.max()}。请先在数据下载页补齐该区间数据。"
                    )

                sliced_df["returns"] = self.target_spec.build(sliced_df)
                sliced_dfs.append(sliced_df)
                
        if sliced_dfs:
            final_df = pd.concat(sliced_dfs)
            return final_df
            
        return pd.DataFrame()

    def get_data(self) -> Any:
        if self._mine_data is None:
            logger.warning("Mine data is empty!")
            return None
            
        if isinstance(self._mine_data, pd.DataFrame):
            if self._mine_data.empty:
                logger.warning("Mine data is empty DataFrame!")
            return self._mine_data.drop(columns=['returns'], errors='ignore')
        elif isinstance(self._mine_data, dict):
            return {k: v for k, v in self._mine_data.items() if k != 'returns'}
            
        return self._mine_data

    def get_returns(self) -> Any:
        if self.mining_mode == "cross_asset":
            return self._mine_data.get('returns') if isinstance(self._mine_data, dict) else pd.DataFrame()
            
        if isinstance(self._mine_data, pd.DataFrame) and 'returns' in self._mine_data.columns:
            return self._mine_data['returns']
        return pd.Series(dtype=float)

    def get_test_data(self) -> Any:
        if isinstance(self._test_data, pd.DataFrame):
            return self._test_data.drop(columns=['returns'], errors='ignore')
        elif isinstance(self._test_data, dict):
            return {k: v for k, v in self._test_data.items() if k != 'returns'}
            
        return self._test_data

    def get_test_returns(self) -> Any:
        if self.mining_mode == "cross_asset":
            return self._test_data.get('returns') if isinstance(self._test_data, dict) else pd.DataFrame()
            
        if isinstance(self._test_data, pd.DataFrame) and 'returns' in self._test_data.columns:
            return self._test_data['returns']
        return pd.Series(dtype=float)

    def get_target_spec(self) -> ForwardReturnTarget:
        return self.target_spec

    def get_forward_return_definition(self) -> str:
        return self.target_spec.definition()
