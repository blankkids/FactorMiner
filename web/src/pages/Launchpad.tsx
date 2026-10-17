import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { Play, Filter, Terminal, HardDrive } from 'lucide-react';
import ReactECharts from 'echarts-for-react';
import { useWebSocket } from '../hooks/useWebSocket';
import { useI18n } from '../i18n';

const TF_MINUTES: Record<string, number> = {
  '1m': 1, '3m': 3, '5m': 5, '15m': 15, '30m': 30,
  '1h': 60, '2h': 120, '4h': 240, '6h': 360, '8h': 480, '12h': 720,
  '1d': 1440, '1w': 10080, '1M': 43200,
};
const tfSort = (a: string, b: string) => (TF_MINUTES[a] ?? Infinity) - (TF_MINUTES[b] ?? Infinity);

export function Launchpad() {
  const [selectedMiner, setSelectedMiner] = useState<string>('');
  const [availableMiners, setAvailableMiners] = useState<string[]>([]);
  
  const [selectedConfig, setSelectedConfig] = useState<string>('');
  const [availableConfigs, setAvailableConfigs] = useState<string[]>([]);
  const [configDetails, setConfigDetails] = useState<Record<string, any>>({});
  const [exchangeOverride, setExchangeOverride] = useState<string>('');
  const [pairOverride, setPairOverride] = useState<string[]>([]);
  const [timeframeOverride, setTimeframeOverride] = useState<string>('');
  const [mineStart, setMineStart] = useState<string>('');
  const [mineEnd, setMineEnd] = useState<string>('');
  const [testStart, setTestStart] = useState<string>('');
  const [testEnd, setTestEnd] = useState<string>('');
  const [localFiles, setLocalFiles] = useState<any[]>([]);

  const [tasks, setTasks] = useState<any[]>([]);
  const [selectedTask, setSelectedTask] = useState<any | null>(null);
  
  // Track scatter points and logs per task
  const [taskData, setTaskData] = useState<Record<string, { scatter: any[], logs: string[] }>>({});

  const { lastMessage, isConnected } = useWebSocket('ws://localhost:8000/ws/monitor');
  const { t } = useI18n();

  useEffect(() => {
    if (!lastMessage) return;
    
    if (lastMessage.type === 'task_update' && lastMessage.task) {
      setTasks(prev => {
        const index = prev.findIndex(t => t.id === lastMessage.task.id);
        if (index !== -1) {
          const updated = [...prev];
          updated[index] = lastMessage.task;
          return updated;
        }
        return [lastMessage.task, ...prev];
      });
      // Also update selected task if it's currently open
      setSelectedTask((current: any | null) => {
        if (current && current.id === lastMessage.task.id) {
          return lastMessage.task;
        }
        return current;
      });
    } else if (lastMessage.type === 'scatter') {
      const tid = lastMessage.task_id;
      if (tid) {
        setTaskData(prev => {
          const current = prev[tid] || { scatter: [], logs: [] };
          return {
            ...prev,
            [tid]: {
              ...current,
              scatter: [...current.scatter, [lastMessage.epoch, lastMessage.ic, lastMessage.complexity]]
            }
          };
        });
      }
    } else if (lastMessage.type === 'log') {
      const tid = lastMessage.task_id;
      if (tid) {
        setTaskData(prev => {
          const current = prev[tid] || { scatter: [], logs: [] };
          return {
            ...prev,
            [tid]: {
              ...current,
              logs: [...current.logs.slice(-49), lastMessage.text]
            }
          };
        });
      }
    }
  }, [lastMessage]);

  useEffect(() => {
    // Fetch Miners
    fetch('http://localhost:8000/api/miners')
      .then(res => res.json())
      .then(data => {
        if (data.miners) {
          setAvailableMiners(data.miners);
          if (data.miners.length > 0 && !data.miners.includes(selectedMiner)) {
            setSelectedMiner(data.miners[0]);
          }
        }
      })
      .catch(err => console.error('Failed to fetch miners:', err));
      
    // Fetch Configs
    fetch('http://localhost:8000/api/configs')
      .then(res => res.json())
      .then(data => {
        if (data.configs) {
          const configNames = Object.keys(data.configs);
          setAvailableConfigs(configNames);
          setConfigDetails(data.configs);
          if (configNames.length > 0 && !configNames.includes(selectedConfig)) {
            setSelectedConfig(configNames[0]);
          }
        }
      })
      .catch(err => console.error('Failed to fetch configs:', err));

    // Fetch local data inventory
    fetch('http://localhost:8000/api/local_data')
      .then(res => res.json())
      .then(data => setLocalFiles(data.files || []))
      .catch(err => console.error('Failed to fetch local data:', err));

    // Fetch Initial Tasks
    fetch('http://localhost:8000/api/tasks')
      .then(res => res.json())
      .then(data => {
        if (data.tasks) setTasks(data.tasks);
      })
      .catch(err => console.error('Failed to fetch tasks:', err));
  }, []);

  const handleLaunch = () => {
    if (!selectedMiner || !selectedConfig) return;
    if (mineStart && mineEnd && mineStart > mineEnd) { alert(t('launchpad.alertPeriod')); return; }
    if (testStart && testEnd && testStart > testEnd) { alert(t('launchpad.alertPeriod')); return; }

    fetch('http://localhost:8000/api/launch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        miner: selectedMiner,
        config: selectedConfig,
        ...(exchangeOverride ? { exchange: exchangeOverride } : {}),
        ...(pairOverride.length ? { pairs: pairOverride } : {}),
        ...(timeframeOverride ? { timeframe: timeframeOverride } : {}),
        ...(mineDirty ? { mine_period: [[mineStart, mineEnd]] } : {}),
        ...(testDirty ? { test_period: [[testStart, testEnd]] } : {})
      })
    })
    .then(res => res.json())
    .then(data => {
      console.log('Task launched:', data.task_id);
    })
    .catch(err => console.error('Failed to launch task:', err));
  };

  const getTaskLogs = (task: any): string[] => taskData[task.id]?.logs || task.logs || [];

  const configExchange: string = configDetails[selectedConfig]?.data_feeds?.exchange || 'binance';
  const effectiveExchange = exchangeOverride || configExchange;

  const configInstrument: string = configDetails[selectedConfig]?.data_feeds?.instrument_type || 'futures';
  const configTimeframe: string = configDetails[selectedConfig]?.data_feeds?.timeframe || '1m';
  const configPairs: string[] = configDetails[selectedConfig]?.data_feeds?.pairs || [];
  const [configMineStart, configMineEnd] = configDetails[selectedConfig]?.data_feeds?.mine_period?.[0] || [];
  const [configTestStart, configTestEnd] = configDetails[selectedConfig]?.data_feeds?.test_period?.[0] || [];

  // Local data inventory scoped to the effective exchange + the config's instrument type
  const localSymbols = new Map<string, Set<string>>();
  for (const f of localFiles) {
    if (f.exchange === effectiveExchange && f.instrument_type === configInstrument) {
      if (!localSymbols.has(f.symbol)) localSymbols.set(f.symbol, new Set());
      localSymbols.get(f.symbol)!.add(f.timeframe);
    }
  }

  // Timeframes available locally: intersection across selected pairs, or all in scope
  const tfSourcePairs = pairOverride.filter(p => localSymbols.has(p));
  const tfSets = (tfSourcePairs.length ? tfSourcePairs : [...localSymbols.keys()])
    .map(p => localSymbols.get(p)!);
  const availableTimeframes = tfSets.length
    ? [...tfSets.reduce((acc, s) => new Set([...acc].filter(t => s.has(t))), new Set(tfSets[0]))].sort(tfSort)
    : [];

  const effectivePairs = pairOverride.length ? pairOverride : configPairs;
  const effectiveTimeframe = timeframeOverride || configTimeframe;
  const mineDirty = Boolean(mineStart && mineEnd && (mineStart !== configMineStart || mineEnd !== configMineEnd));
  const testDirty = Boolean(testStart && testEnd && (testStart !== configTestStart || testEnd !== configTestEnd));

  // Prefill defaults: mine = last 30 days, test = the 30 days immediately before it (disjoint windows).
  // Re-syncs when the config changes; user edits are never clobbered.
  useEffect(() => {
    const fmt = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const today = new Date();
    setMineStart(fmt(new Date(today.getTime() - 30 * 86400000)));
    setMineEnd(fmt(today));
    setTestStart(fmt(new Date(today.getTime() - 60 * 86400000)));
    setTestEnd(fmt(new Date(today.getTime() - 31 * 86400000)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedConfig]);

  // Drop overrides that left the current scope (config/exchange change)
  useEffect(() => {
    setPairOverride(prev => {
      const next = prev.filter(p => localSymbols.has(p));
      return next.length === prev.length ? prev : next;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [effectiveExchange, configInstrument, selectedConfig]);

  useEffect(() => {
    if (timeframeOverride && availableTimeframes.length && !availableTimeframes.includes(timeframeOverride)) {
      setTimeframeOverride('');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [timeframeOverride, availableTimeframes.join(',')]);

  return (
    <div className="flex flex-col h-full gap-6">
      {/* Top Panel: Unified Launch Form */}
      <div className="p-6 border border-border bg-card rounded-xl flex flex-col gap-6">
        <h2 className="text-sm font-bold text-foreground">{t('launchpad.startNewMining')}</h2>

        <div className="grid grid-cols-2 lg:grid-cols-4 gap-8">
          {/* Miner Selection */}
          <div className="space-y-2">
            <label className="text-xs font-medium text-muted-foreground">{t('launchpad.minerEngine')}</label>
            <select
              value={selectedMiner}
              onChange={(e) => setSelectedMiner(e.target.value)}
              className="w-full bg-background border border-border rounded-md px-3 py-2 text-sm text-foreground focus:outline-none focus:border-primary"
            >
              {availableMiners.map(miner => (
                <option key={miner} value={miner}>{miner}</option>
              ))}
            </select>
          </div>

          {/* Config Selection */}
          <div className="space-y-2">
            <label className="text-xs font-medium text-muted-foreground">{t('launchpad.config')}</label>
            <select
              value={selectedConfig}
              onChange={(e) => setSelectedConfig(e.target.value)}
              className="w-full bg-background border border-border rounded-md px-3 py-2 text-sm text-foreground focus:outline-none focus:border-primary"
            >
              {availableConfigs.map(config => (
                <option key={config} value={config}>{config}</option>
              ))}
            </select>
          </div>

          {/* Data Source (Exchange) Override */}
          <div className="space-y-2">
            <label className="text-xs font-medium text-muted-foreground">{t('launchpad.exchange')}</label>
            <select
              value={exchangeOverride}
              onChange={(e) => setExchangeOverride(e.target.value)}
              className="w-full bg-background border border-border rounded-md px-3 py-2 text-sm text-foreground focus:outline-none focus:border-primary"
            >
              <option value="">{t('launchpad.configDefault', { value: configExchange })}</option>
              <option value="binance">Binance</option>
              <option value="okx">OKX</option>
            </select>
          </div>

          {/* Timeframe Override */}
          <div className="space-y-2">
            <label className="text-xs font-medium text-muted-foreground">{t('launchpad.timeframe')}</label>
            <select
              value={timeframeOverride}
              onChange={(e) => setTimeframeOverride(e.target.value)}
              className="w-full bg-background border border-border rounded-md px-3 py-2 text-sm text-foreground focus:outline-none focus:border-primary"
            >
              <option value="">{t('launchpad.configDefault', { value: configTimeframe })}</option>
              {availableTimeframes.map(tf => (
                <option key={tf} value={tf}>{tf}</option>
              ))}
            </select>
          </div>
        </div>

        {/* Target Pairs Override (from local data inventory) */}
        <div className="space-y-2">
          <label className="text-xs font-medium text-muted-foreground flex justify-between items-center">
            <span className="flex items-center gap-2">
              <HardDrive className="w-3.5 h-3.5" /> {t('launchpad.targetPairs')}
            </span>
            <span className="text-xs text-primary normal-case">
              {pairOverride.length > 0
                ? t('common.nSelected', { count: pairOverride.length })
                : t('launchpad.configDefaultPairs', { value: configPairs.join(', ') || t('common.none') })}
            </span>
          </label>
          <div className="h-24 overflow-y-auto border border-border rounded-md p-2 bg-background flex flex-wrap gap-2 content-start">
            {[...localSymbols.keys()].sort().map(sym => (
              <button
                key={sym}
                onClick={() => setPairOverride(prev =>
                  prev.includes(sym) ? prev.filter(v => v !== sym) : [...prev, sym]
                )}
                title={`Local: ${[...localSymbols.get(sym)!].sort(tfSort).join(', ')}`}
                className={`px-3 py-1 text-xs rounded-full border transition-colors font-mono ${
                  pairOverride.includes(sym)
                    ? 'bg-primary text-primary-foreground border-primary'
                    : 'bg-secondary text-secondary-foreground border-border hover:border-primary/50'
                }`}
              >
                {sym}
              </button>
            ))}
            {localSymbols.size === 0 && (
              <span className="text-xs text-muted-foreground italic p-1">
                {t('launchpad.noLocalData', { exchange: effectiveExchange, instrument: configInstrument })}
              </span>
            )}
          </div>
        </div>

        {/* Mining / Test Period Overrides */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
          <div className="space-y-2">
            <label className="text-xs font-medium text-muted-foreground flex items-center gap-2">
              {t('launchpad.miningPeriod')}
              {mineDirty && <span className="text-primary">{t('launchpad.overrideBadge')}</span>}
            </label>
            <div className="flex items-center gap-2">
              <input
                type="date"
                value={mineStart}
                onChange={(e) => setMineStart(e.target.value)}
                style={{ colorScheme: 'dark' }}
                className="flex-1 bg-background border border-border rounded-md px-3 py-2 text-sm text-foreground font-mono focus:outline-none focus:border-primary"
              />
              <span className="text-muted-foreground">~</span>
              <input
                type="date"
                value={mineEnd}
                onChange={(e) => setMineEnd(e.target.value)}
                style={{ colorScheme: 'dark' }}
                className="flex-1 bg-background border border-border rounded-md px-3 py-2 text-sm text-foreground font-mono focus:outline-none focus:border-primary"
              />
            </div>
          </div>
          <div className="space-y-2">
            <label className="text-xs font-medium text-muted-foreground flex items-center gap-2">
              {t('launchpad.testPeriod')}
              {testDirty && <span className="text-primary">{t('launchpad.overrideBadge')}</span>}
            </label>
            <div className="flex items-center gap-2">
              <input
                type="date"
                value={testStart}
                onChange={(e) => setTestStart(e.target.value)}
                style={{ colorScheme: 'dark' }}
                className="flex-1 bg-background border border-border rounded-md px-3 py-2 text-sm text-foreground font-mono focus:outline-none focus:border-primary"
              />
              <span className="text-muted-foreground">~</span>
              <input
                type="date"
                value={testEnd}
                onChange={(e) => setTestEnd(e.target.value)}
                style={{ colorScheme: 'dark' }}
                className="flex-1 bg-background border border-border rounded-md px-3 py-2 text-sm text-foreground font-mono focus:outline-none focus:border-primary"
              />
            </div>
          </div>
        </div>

        {/* Config Summary Card */}
        {selectedConfig && configDetails[selectedConfig] && !configDetails[selectedConfig].error && (
          <div className="p-4 rounded-lg border border-dashed border-muted-foreground/50 bg-secondary/10">
            <h3 className="text-xs font-bold text-muted-foreground mb-3 uppercase tracking-wider">{t('launchpad.profileSummary')}</h3>
            <div className="grid grid-cols-3 gap-6 text-sm">
              <div>
                <span className="block text-xs text-muted-foreground mb-1">{t('launchpad.targetPairsShort')}</span>
                <span className="font-mono text-xs">
                  {effectivePairs.join(', ') || t('common.none')}
                  {pairOverride.length > 0 && (
                    <span className="text-primary ml-1" title={t('launchpad.overrideTitle')}>{t('launchpad.overrideBadge')}</span>
                  )}
                </span>
              </div>
              <div>
                <span className="block text-xs text-muted-foreground mb-1">{t('launchpad.exchange')}</span>
                <span className="font-mono text-xs">
                  {effectiveExchange}
                  {exchangeOverride && exchangeOverride !== configExchange && (
                    <span className="text-primary ml-1" title={t('launchpad.overrideTitle')}>{t('launchpad.overrideBadge')}</span>
                  )}
                </span>
              </div>
              <div>
                <span className="block text-xs text-muted-foreground mb-1">{t('launchpad.timeframeMode')}</span>
                <span className="font-mono text-xs">
                  {effectiveTimeframe} | {configDetails[selectedConfig].data_feeds?.mining_mode || t('common.none')}
                  {timeframeOverride && (
                    <span className="text-primary ml-1" title={t('launchpad.overrideTitle')}>{t('launchpad.overrideBadge')}</span>
                  )}
                </span>
              </div>
              <div>
                <span className="block text-xs text-muted-foreground mb-1">{t('launchpad.scale')}</span>
                <span className="font-mono text-xs">
                  {t('launchpad.scaleValue', {
                    pop: configDetails[selectedConfig].population_size || t('common.none'),
                    iter: configDetails[selectedConfig].max_iterations || t('common.none'),
                  })}
                </span>
              </div>
              <div>
                <span className="block text-xs text-muted-foreground mb-1">{t('launchpad.miningPeriod')}</span>
                <span className="font-mono text-xs">
                  {mineDirty ? `${mineStart} ~ ${mineEnd}` : `${configMineStart || t('common.none')} ~ ${configMineEnd || t('common.none')}`}
                  {mineDirty && (
                    <span className="text-primary ml-1" title={t('launchpad.overrideTitle')}>{t('launchpad.overrideBadge')}</span>
                  )}
                </span>
              </div>
              <div>
                <span className="block text-xs text-muted-foreground mb-1">{t('launchpad.fitnessHook')}</span>
                <span className="font-mono text-xs">{configDetails[selectedConfig].fitness?.hook || t('common.none')}</span>
              </div>
              <div>
                <span className="block text-xs text-muted-foreground mb-1">{t('launchpad.searchSpace')}</span>
                <span className="font-mono truncate block text-xs" title={configDetails[selectedConfig].search_space?.allowed_operators?.join(', ')}>
                  {configDetails[selectedConfig].search_space?.allowed_operators?.join(', ') || t('common.none')}
                </span>
              </div>
            </div>
          </div>
        )}

        {/* Bottom Launch Button */}
        <div className="pt-4 border-t border-border mt-2">
          <button 
            onClick={handleLaunch}
            className="w-full flex items-center justify-center gap-2 bg-primary text-primary-foreground py-3 rounded-md font-bold hover:opacity-90 transition-opacity text-base"
          >
            <Play className="w-5 h-5 fill-current" /> {t('home.startMining')}
          </button>
        </div>
      </div>

      {/* Bottom Panel: Tracker Table */}
      <div className="flex-1 flex flex-col border border-border bg-card rounded-xl overflow-hidden relative">
        <div className="p-4 border-b border-border flex items-center justify-between bg-secondary/30">
          <h2 className="text-sm font-bold text-foreground">{t('launchpad.tracker')}</h2>
          <Filter className="w-4 h-4 text-muted-foreground" />
        </div>
        <div className="flex-1 overflow-auto">
          <table className="w-full text-sm text-left">
            <thead className="text-xs text-muted-foreground bg-background sticky top-0">
              <tr>
                <th className="px-6 py-3 font-medium border-b border-border">{t('launchpad.colTaskId')}</th>
                <th className="px-6 py-3 font-medium border-b border-border">{t('launchpad.colStatus')}</th>
                <th className="px-6 py-3 font-medium border-b border-border">{t('launchpad.colParadigm')}</th>
                <th className="px-6 py-3 font-medium border-b border-border">{t('launchpad.colDuration')}</th>
                <th className="px-6 py-3 font-medium border-b border-border">{t('launchpad.colHash')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {tasks.length === 0 && (
                <tr><td colSpan={5} className="text-center py-8 text-muted-foreground">{t('launchpad.noTasks')}</td></tr>
              )}
              {tasks.map((row) => (
                <tr 
                  key={row.id} 
                  className="hover:bg-secondary/50 transition-colors cursor-pointer"
                  onClick={() => setSelectedTask(row)}
                >
                  <td className="px-6 py-3 font-mono">{row.id}</td>
                  <td className="px-6 py-3">
                    {row.status === 'running' && <span className="text-yellow-500">🟢 运行中 ({row.progress}%)</span>}
                    {row.status === 'completed' && <span className="text-green-500">✅ 完成</span>}
                    {row.status === 'completed_empty' && <span className="text-amber-500">⚠️ 已完成（无有效因子）</span>}
                    {row.status === 'failed' && <span className="text-red-500">🔴 失败</span>}
                  </td>
                  <td className="px-6 py-3">
                    <span className="px-2 py-1 bg-secondary rounded text-xs">{row.miner}</span>
                    {row.exchange && (
                      <span className="ml-2 font-mono text-xs text-muted-foreground">{row.exchange}</span>
                    )}
                  </td>
                  <td className="px-6 py-3 text-muted-foreground">{row.duration}</td>
                  <td className="px-6 py-3 font-mono text-xs text-muted-foreground">{row.hash}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        
        {/* Details Modal Overlay */}
        {selectedTask && (
          <div className="fixed inset-0 bg-background/80 backdrop-blur-sm z-50 flex items-center justify-center p-6">
            <div className="bg-card border border-border shadow-2xl rounded-xl w-full max-w-4xl h-[80vh] flex flex-col overflow-hidden animate-in fade-in zoom-in-95 duration-200">
              <div className="p-4 border-b border-border flex justify-between items-center bg-secondary/30">
              <h3 className="font-bold text-sm flex items-center gap-2">
                {t('launchpad.taskDetails')} <span className="font-mono text-muted-foreground">{selectedTask.id}</span>
                <span className={`w-2 h-2 rounded-full ml-2 ${isConnected ? 'bg-green-500' : 'bg-red-500'}`} title={isConnected ? t('launchpad.wsConnected') : t('launchpad.wsDisconnected')} />
              </h3>
              <button onClick={() => setSelectedTask(null)} className="text-muted-foreground hover:text-foreground text-xl leading-none">&times;</button>
            </div>
            <div className="p-6 flex-1 overflow-auto flex flex-col gap-6">
              
              {/* Metadata Section */}
              <div className="space-y-4 shrink-0">
                <div className="grid grid-cols-2 gap-4 text-sm">
                  <div><span className="text-muted-foreground">{t('launchpad.mStatus')}:</span> <span className="font-bold capitalize">{selectedTask.status}</span></div>
                  <div><span className="text-muted-foreground">{t('launchpad.mProgress')}:</span> {selectedTask.progress}%</div>
                  <div><span className="text-muted-foreground">{t('launchpad.mMiner')}:</span> {selectedTask.miner}</div>
                  <div><span className="text-muted-foreground">{t('launchpad.mConfig')}:</span> {selectedTask.config}</div>
                  <div className="col-span-2"><span className="text-muted-foreground">{t('launchpad.mStartTime')}:</span> {new Date(selectedTask.start_time).toLocaleString()}</div>
                </div>
                
                {selectedTask.status === 'failed' && (
                  <div className="mt-4 p-4 bg-red-950/20 border border-red-900/50 rounded text-red-400 text-xs font-mono overflow-auto whitespace-pre-wrap">
                    {selectedTask.error_msg}
                  </div>
                )}
                
                {selectedTask.status === 'completed' && (
                  <div className="mt-4 p-4 border border-green-900/30 bg-green-950/10 rounded">
                    <h4 className="text-green-500 font-bold mb-2">{t('launchpad.miningSuccessful')}</h4>
                    <p className="text-sm text-muted-foreground mb-4">{t('launchpad.factorsSaved', { count: selectedTask.result_count || 0 })}</p>
                    <div className="text-xs font-mono bg-background p-2 rounded border border-border">
                      {t('launchpad.bestHash')}: {selectedTask.hash}
                    </div>
                  </div>
                )}

                {selectedTask.factors?.length > 0 && (
                  <div className="border border-border rounded-lg overflow-hidden">
                    <div className="px-4 py-3 bg-secondary/30 flex items-center justify-between">
                      <h4 className="text-sm font-bold">{t('launchpad.minedFactors')}</h4>
                      <span className="text-xs text-muted-foreground">{t('launchpad.nSaved', { count: selectedTask.factors.length })}</span>
                    </div>
                    <div className="max-h-56 overflow-auto">
                      <table className="w-full text-xs text-left">
                        <thead className="sticky top-0 bg-card text-muted-foreground">
                          <tr>
                            <th className="px-4 py-2">{t('launchpad.colFactorId')}</th>
                            <th className="px-4 py-2">{t('launchpad.colExpression')}</th>
                            <th className="px-4 py-2 text-right">{t('launchpad.colFitness')}</th>
                            <th className="px-4 py-2 text-right">IC</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-border">
                          {selectedTask.factors.map((factor: any) => (
                            <tr key={factor.factor_id}>
                              <td className="px-4 py-2 font-mono whitespace-nowrap">
                                <Link to={`/inspector?factor=${encodeURIComponent(factor.factor_id)}`} className="text-primary hover:underline" onClick={(event) => event.stopPropagation()}>
                                  {factor.factor_id}
                                </Link>
                              </td>
                              <td className="px-4 py-2 font-mono break-all">{factor.logic}</td>
                              <td className="px-4 py-2 text-right">{factor.metrics?.fitness_score?.toFixed?.(4) ?? '—'}</td>
                              <td className="px-4 py-2 text-right">{factor.metrics?.IC?.toFixed?.(4) ?? '—'}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}

                {selectedTask.status === 'completed_empty' && (
                  <div className="mt-4 p-4 border border-amber-900/50 bg-amber-950/20 rounded">
                    <h4 className="text-amber-500 font-bold mb-2">{t('launchpad.finishedEmpty')}</h4>
                    <p className="text-sm text-muted-foreground">
                      {selectedTask.error_msg || t('launchpad.finishedEmptyHint')}
                    </p>
                  </div>
                )}
                
                {selectedTask.status === 'running' && (
                  <div className="mt-4">
                    <div className="flex justify-between mb-1">
                      <span className="text-xs font-bold text-muted-foreground">{t('launchpad.liveProgress')}</span>
                      <span className="text-xs font-mono text-primary">{selectedTask.progress}%</span>
                    </div>
                    <div className="w-full bg-secondary rounded-full h-1.5">
                      <div className="bg-primary h-1.5 rounded-full transition-all duration-500" style={{ width: `${selectedTask.progress}%` }}></div>
                    </div>
                  </div>
                )}
              </div>

              {/* Omni-Drawer Visualizations (Scatter & Logs) */}
              <div className="flex-1 flex flex-col gap-6 min-h-[500px]">
                {/* Scatter Plot */}
                <div className="flex-1 border border-border bg-card rounded-xl p-4 flex flex-col relative min-h-[250px]">
                  <h4 className="text-xs font-bold text-foreground mb-2">{t('launchpad.fitnessEvolution')}</h4>
                  <div className="flex-1 w-full min-h-0">
                    <ReactECharts 
                      option={{
                        backgroundColor: 'transparent',
                        grid: { top: 20, right: 20, bottom: 20, left: 40 },
                        tooltip: {
                          trigger: 'item',
                          formatter: function (params: any) {
                            return `${t('launchpad.epoch')}: ${params.value[0]}<br/>IC: ${params.value[1].toFixed(4)}<br/>${t('launchpad.complexity')}: ${params.value[2]}`;
                          }
                        },
                        xAxis: { type: 'value', splitLine: { lineStyle: { color: 'rgba(255,255,255,0.05)' } }, axisLabel: { color: '#888', fontSize: 10 } },
                        yAxis: { type: 'value', splitLine: { lineStyle: { color: 'rgba(255,255,255,0.05)' } }, axisLabel: { color: '#888', fontSize: 10 } },
                        visualMap: {
                          show: false,
                          min: 1,
                          max: 15,
                          dimension: 2,
                          inRange: { color: ['#171e3b', '#3f51b5', '#00ff9d'] },
                        },
                        series: [{
                          type: 'scatter',
                          symbolSize: 6,
                          data: taskData[selectedTask.id]?.scatter || [],
                          itemStyle: { opacity: 0.8 }
                        }]
                      }} 
                      style={{ height: '100%', width: '100%' }} 
                    />
                  </div>
                </div>

                {/* Execution Console Logs */}
                <div className="h-48 border border-border bg-black rounded-xl p-3 flex flex-col font-mono text-xs shrink-0">
                  <div className="flex items-center gap-2 text-primary mb-2 border-b border-border pb-2 shrink-0">
                    <Terminal className="w-4 h-4" />
                    <span>{t('common.console')}</span>
                  </div>
                  <div className="flex-1 overflow-y-auto space-y-1 text-muted-foreground flex flex-col-reverse">
                    {getTaskLogs(selectedTask).slice().reverse().map((log, i) => (
                      <div key={i} className="hover:text-foreground transition-colors">{log}</div>
                    ))}
                    {getTaskLogs(selectedTask).length === 0 && (
                      <div className="text-muted-foreground/50 italic">{t('common.waitingLogs')}</div>
                    )}
                  </div>
                </div>
              </div>

              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
