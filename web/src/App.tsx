/**
 * Dashboard.
 *
 * Layout rationale: the top row answers "what is the state of this pool right
 * now" in one glance, and everything below is supporting detail. A reviewer
 * should be able to tell within a few seconds whether the data looks real.
 *
 * The freshness strip is not decoration. An indexer's most dangerous failure is
 * being quietly stale — charts that look plausible while describing hours ago —
 * so the UI states the last indexed block and the lag explicitly.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { api, type CandleDto, type HealthDto, type StatsDto, type SwapDto } from './api.ts';

const INTERVALS = ['1m', '5m', '15m', '1h', '4h', '1d'] as const;
const WINDOWS = [
  { label: '1h', hours: 1 },
  { label: '4h', hours: 4 },
  { label: '24h', hours: 24 },
  { label: '7d', hours: 168 },
] as const;

export function App(): React.ReactElement {
  const [interval, setInterval] = useState<(typeof INTERVALS)[number]>('5m');
  const [hours, setHours] = useState<number>(6);
  const [stats, setStats] = useState<StatsDto | null>(null);
  const [candles, setCandles] = useState<CandleDto[]>([]);
  const [swaps, setSwaps] = useState<SwapDto[]>([]);
  const [health, setHealth] = useState<HealthDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const [s, o, sw, h] = await Promise.all([
        api.stats(hours),
        api.ohlcv(interval, hours),
        api.swaps(40),
        api.health(),
      ]);
      setStats(s);
      setCandles(o.candles);
      setSwaps(sw.swaps);
      setHealth(h);
      setError(null);
    } catch (e) {
      // Surface the reason rather than rendering an empty chart, which would
      // look like "no trades" instead of "the API is not running".
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [interval, hours]);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), 15_000);
    return () => window.clearInterval(timer);
  }, [load]);

  const chartData = useMemo(
    () =>
      candles.map((c) => ({
        ts: c.ts,
        time: new Date(c.ts * 1000).toISOString().slice(11, 16),
        fullTime: new Date(c.ts * 1000).toISOString().replace('T', ' ').slice(0, 16) + ' UTC',
        // `close`, not `price`: the OHLCV endpoint returns open/high/low/close
        // and has no `price` field. Reading a field that does not exist yields
        // undefined, which poisons the whole Y scale with NaN and renders an
        // empty chart without throwing.
        price: c.close,
        volume: c.volumeUsdc,
        trades: c.trades,
      })),
    [candles],
  );

  const priceDomain = useMemo(() => {
    if (chartData.length === 0) return ['auto', 'auto'] as const;
    const values = chartData.map((d) => d.price);
    const min = Math.min(...values);
    const max = Math.max(...values);
    const pad = Math.max((max - min) * 0.1, max * 0.0005);
    return [min - pad, max + pad] as const;
  }, [chartData]);

  return (
    <div style={{ maxWidth: 1180, margin: '0 auto', padding: '28px 20px 64px' }}>
      <Header health={health} />
      <Freshness health={health} />

      {error && (
        <div
          style={{
            background: '#2d1416',
            border: '1px solid #5c2027',
            color: '#ffb4ab',
            padding: '12px 14px',
            borderRadius: 8,
            marginBottom: 18,
            fontSize: 13,
          }}
        >
          <strong>API error:</strong> {error}
          <div style={{ color: '#c99', marginTop: 4 }}>
            Start it with <code>npm run api</code> (serves http://127.0.0.1:3001).
          </div>
        </div>
      )}

      <Kpis stats={stats} />

      <Panel
        title="Price"
        subtitle={`${interval} candles · last ${hours}h · close price, USDC per WETH`}
        controls={
          <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
            <Segmented
              options={INTERVALS.map((i) => ({ label: i, value: i }))}
              value={interval}
              onChange={(v) => setInterval(v as (typeof INTERVALS)[number])}
            />
            <Segmented
              options={WINDOWS.map((w) => ({ label: w.label, value: String(w.hours) }))}
              value={String(hours)}
              onChange={(v) => setHours(Number(v))}
            />
          </div>
        }
      >
        {loading ? (
          <Placeholder>loading…</Placeholder>
        ) : chartData.length === 0 ? (
          <Placeholder>no candles in this window</Placeholder>
        ) : (
          <ResponsiveContainer width="100%" height={280}>
            <AreaChart data={chartData} margin={{ top: 6, right: 8, bottom: 0, left: 0 }}>
              <defs>
                <linearGradient id="priceFill" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#4ea1ff" stopOpacity={0.35} />
                  <stop offset="100%" stopColor="#4ea1ff" stopOpacity={0.02} />
                </linearGradient>
              </defs>
              <CartesianGrid stroke="#1d2733" vertical={false} />
              <XAxis dataKey="time" stroke="#5c6b7a" fontSize={11} tickLine={false} minTickGap={40} />
              <YAxis
                stroke="#5c6b7a"
                fontSize={11}
                tickLine={false}
                axisLine={false}
                domain={priceDomain as unknown as [number, number]}
                tickFormatter={(v: number) => v.toFixed(1)}
                width={58}
              />
              <Tooltip content={<PriceTooltip />} />
              <Area
                type="monotone"
                dataKey="price"
                stroke="#4ea1ff"
                strokeWidth={2}
                fill="url(#priceFill)"
                dot={false}
                isAnimationActive={false}
              />
            </AreaChart>
          </ResponsiveContainer>
        )}
      </Panel>

      <Panel title="Volume" subtitle={`USDC traded per ${interval} candle`}>
        {chartData.length === 0 ? (
          <Placeholder>no data</Placeholder>
        ) : (
          <ResponsiveContainer width="100%" height={160}>
            <BarChart data={chartData} margin={{ top: 6, right: 8, bottom: 0, left: 0 }}>
              <CartesianGrid stroke="#1d2733" vertical={false} />
              <XAxis dataKey="time" stroke="#5c6b7a" fontSize={11} tickLine={false} minTickGap={40} />
              <YAxis
                stroke="#5c6b7a"
                fontSize={11}
                tickLine={false}
                axisLine={false}
                tickFormatter={(v: number) => compact(v)}
                width={58}
              />
              <Tooltip content={<VolumeTooltip />} />
              <Bar dataKey="volume" fill="#2f6f5e" isAnimationActive={false} />
            </BarChart>
          </ResponsiveContainer>
        )}
      </Panel>

      <TradesTable swaps={swaps} />
      <Footer health={health} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Presentational pieces
// ---------------------------------------------------------------------------

function Header({ health }: { health: HealthDto | null }): React.ReactElement {
  return (
    <header style={{ marginBottom: 18 }}>
      <h1 style={{ fontSize: 21, margin: 0, fontWeight: 600, letterSpacing: -0.2 }}>
        WETH/USDC swaps on Base
      </h1>
      <p style={{ color: '#8b98a5', margin: '6px 0 0', fontSize: 13 }}>
        Uniswap V3 0.05% pool, indexed from chain by a self-hosted event indexer.
        {health ? ` ${health.swaps.toLocaleString()} swaps stored.` : ''}
      </p>
    </header>
  );
}

/**
 * Data freshness. Lateness is the failure mode an indexer is most likely to
 * hide, so it is displayed rather than inferred.
 */
function Freshness({ health }: { health: HealthDto | null }): React.ReactElement | null {
  if (!health) return null;
  const lag = health.lag;
  const stale = lag !== null && lag > 300;
  return (
    <div
      style={{
        display: 'flex',
        gap: 18,
        flexWrap: 'wrap',
        fontSize: 11.5,
        color: '#8b98a5',
        padding: '7px 12px',
        background: '#101720',
        border: '1px solid #1d2733',
        borderRadius: 7,
        marginBottom: 20,
      }}
    >
      <span>
        last indexed block{' '}
        <strong style={{ color: '#c9d4de' }}>{health.lastIndexedBlock?.toLocaleString() ?? '—'}</strong>
      </span>
      <span>
        chain head{' '}
        <strong style={{ color: '#c9d4de' }}>{health.chainHead?.toLocaleString() ?? 'unavailable'}</strong>
      </span>
      <span>
        lag{' '}
        <strong style={{ color: stale ? '#f0a020' : '#3fb950' }}>
          {lag === null ? 'unknown' : `${lag} blocks`}
        </strong>
      </span>
      {health.updatedAt && (
        <span>
          indexer last ran{' '}
          <strong style={{ color: '#c9d4de' }}>
            {new Date(health.updatedAt).toISOString().replace('T', ' ').slice(0, 16)} UTC
          </strong>
        </span>
      )}
    </div>
  );
}

function Kpis({ stats }: { stats: StatsDto | null }): React.ReactElement {
  const s = stats;
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))',
        gap: 12,
        marginBottom: 22,
      }}
    >
      <Kpi
        label="Price"
        value={s && s.priceNow > 0 ? `$${s.priceNow.toFixed(2)}` : '—'}
        sub={s && s.changePct !== 0 ? `${(s.changePct * 100).toFixed(2)}%` : undefined}
        tone={s && s.changePct > 0 ? 'up' : s && s.changePct < 0 ? 'down' : 'flat'}
      />
      <Kpi
        label="VWAP"
        value={s && s.vwap > 0 ? `$${s.vwap.toFixed(2)}` : '—'}
        sub="volume weighted"
      />
      <Kpi
        label="Volume"
        value={s ? `$${compact(s.volumeUsdc)}` : '—'}
        sub={s ? `in ${s.windowHours}h` : undefined}
      />
      <Kpi label="Trades" value={s ? s.trades.toLocaleString() : '—'} sub="swap events" />
      <Kpi label="Unique recipients" value={s ? s.uniqueTraders.toLocaleString() : '—'} />
      <Kpi
        label="Range"
        value={s && s.high > 0 ? `${s.low.toFixed(0)}–${s.high.toFixed(0)}` : '—'}
        sub="low–high"
      />
    </div>
  );
}

function Kpi({
  label,
  value,
  sub,
  tone = 'flat',
}: {
  label: string;
  value: string;
  sub?: string | undefined;
  tone?: 'up' | 'down' | 'flat';
}): React.ReactElement {
  const color = tone === 'up' ? '#3fb950' : tone === 'down' ? '#f85149' : '#8b98a5';
  return (
    <div
      style={{
        background: '#121820',
        border: '1px solid #1d2733',
        borderRadius: 9,
        padding: '12px 14px',
      }}
    >
      <div style={{ fontSize: 11, color: '#7d8b99', textTransform: 'uppercase', letterSpacing: 0.6 }}>
        {label}
      </div>
      <div style={{ fontSize: 21, fontWeight: 600, marginTop: 3, fontVariantNumeric: 'tabular-nums' }}>
        {value}
      </div>
      {sub && <div style={{ fontSize: 11.5, color, marginTop: 2 }}>{sub}</div>}
    </div>
  );
}

function Panel({
  title,
  subtitle,
  controls,
  children,
}: {
  title: string;
  subtitle?: string;
  controls?: React.ReactNode;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <section
      style={{
        background: '#121820',
        border: '1px solid #1d2733',
        borderRadius: 10,
        padding: '14px 16px 10px',
        marginBottom: 18,
      }}
    >
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'baseline',
          gap: 14,
          flexWrap: 'wrap',
          marginBottom: 6,
        }}
      >
        <div>
          <h2 style={{ fontSize: 14, margin: 0, fontWeight: 600 }}>{title}</h2>
          {subtitle && <div style={{ fontSize: 11.5, color: '#7d8b99', marginTop: 2 }}>{subtitle}</div>}
        </div>
        {controls}
      </div>
      {children}
    </section>
  );
}

function Segmented({
  options,
  value,
  onChange,
}: {
  options: Array<{ label: string; value: string }>;
  value: string;
  onChange: (v: string) => void;
}): React.ReactElement {
  return (
    <div style={{ display: 'flex', border: '1px solid #24313d', borderRadius: 7, overflow: 'hidden' }}>
      {options.map((o) => (
        <button
          key={o.value}
          onClick={() => onChange(o.value)}
          style={{
            background: o.value === value ? '#1f2b38' : 'transparent',
            color: o.value === value ? '#e6edf3' : '#8b98a5',
            border: 'none',
            padding: '4px 10px',
            fontSize: 11.5,
            cursor: 'pointer',
          }}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function Placeholder({ children }: { children: React.ReactNode }): React.ReactElement {
  return (
    <div style={{ padding: '36px 0', textAlign: 'center', color: '#5c6b7a', fontSize: 12.5 }}>
      {children}
    </div>
  );
}

interface TooltipPayload {
  payload?: { fullTime?: string; price?: number; volume?: number; trades?: number };
}

function PriceTooltip({ active, payload }: { active?: boolean; payload?: TooltipPayload[] }): React.ReactElement | null {
  if (!active || !payload?.length) return null;
  const p = payload[0]?.payload;
  if (!p) return null;
  return (
    <div style={tooltipStyle}>
      <div style={{ color: '#8b98a5', marginBottom: 3 }}>{p.fullTime}</div>
      <div>price <strong>${p.price?.toFixed(2)}</strong></div>
      <div style={{ color: '#8b98a5' }}>{p.trades} trades</div>
    </div>
  );
}

function VolumeTooltip({ active, payload }: { active?: boolean; payload?: TooltipPayload[] }): React.ReactElement | null {
  if (!active || !payload?.length) return null;
  const p = payload[0]?.payload;
  if (!p) return null;
  return (
    <div style={tooltipStyle}>
      <div style={{ color: '#8b98a5', marginBottom: 3 }}>{p.fullTime}</div>
      <div>volume <strong>${compact(p.volume ?? 0)}</strong></div>
      <div style={{ color: '#8b98a5' }}>{p.trades} trades</div>
    </div>
  );
}

const tooltipStyle: React.CSSProperties = {
  background: '#0f151d',
  border: '1px solid #24313d',
  borderRadius: 7,
  padding: '7px 10px',
  fontSize: 12,
};

/**
 * Recent trades. Recipient addresses are truncated to the familiar
 * 0x1234…abcd form; the full value stays in the title attribute so it can
 * still be copied or verified.
 */
function TradesTable({ swaps }: { swaps: SwapDto[] }): React.ReactElement {
  if (swaps.length === 0) {
    return (
      <Panel title="Recent trades">
        <Placeholder>no swaps indexed yet — run `npm run index`</Placeholder>
      </Panel>
    );
  }
  return (
    <Panel title="Recent trades" subtitle={`latest ${swaps.length} swap events, newest first`}>
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5 }}>
          <thead>
            <tr style={{ color: '#7d8b99', textAlign: 'left' }}>
              <Th>time (UTC)</Th>
              <Th>side</Th>
              <Th right>WETH</Th>
              <Th right>USDC</Th>
              <Th right>price</Th>
              <Th>recipient</Th>
              <Th>tx</Th>
            </tr>
          </thead>
          <tbody>
            {swaps.map((s) => (
              <tr key={`${s.blockNumber}-${s.logIndex}`} style={{ borderTop: '1px solid #1a232d' }}>
                <Td mono>{new Date(s.timestamp * 1000).toISOString().slice(11, 19)}</Td>
                <Td>
                  <span
                    style={{
                      color: s.action === 'buy' ? '#3fb950' : '#f85149',
                      fontWeight: 600,
                    }}
                  >
                    {s.action}
                  </span>
                </Td>
                <Td right mono>
                  {Math.abs(s.amount0).toFixed(4)}
                </Td>
                <Td right mono>
                  {Math.abs(s.amount1).toFixed(2)}
                </Td>
                <Td right mono>
                  ${s.price.toFixed(2)}
                </Td>
                <Td mono title={s.recipient}>
                  {short(s.recipient)}
                </Td>
                <Td mono title={s.txHash}>
                  <a
                    href={`https://basescan.org/tx/${s.txHash}`}
                    target="_blank"
                    rel="noreferrer noopener"
                    style={{ textDecoration: 'none' }}
                  >
                    {short(s.txHash)}
                  </a>
                </Td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}

function Th({ children, right }: { children: React.ReactNode; right?: boolean }): React.ReactElement {
  return (
    <th
      style={{
        padding: '6px 8px',
        fontWeight: 500,
        fontSize: 11,
        textTransform: 'uppercase',
        letterSpacing: 0.5,
        textAlign: right ? 'right' : 'left',
        whiteSpace: 'nowrap',
      }}
    >
      {children}
    </th>
  );
}

function Td({
  children,
  right,
  mono,
  title,
}: {
  children: React.ReactNode;
  right?: boolean;
  mono?: boolean;
  /** Full value, when the visible text is an abbreviation (addresses, hashes). */
  title?: string;
}): React.ReactElement {
  return (
    <td
      title={title}
      style={{
        padding: '6px 8px',
        textAlign: right ? 'right' : 'left',
        fontFamily: mono ? 'ui-monospace, SFMono-Regular, Menlo, monospace' : undefined,
        fontVariantNumeric: 'tabular-nums',
        whiteSpace: 'nowrap',
      }}
    >
      {children}
    </td>
  );
}

function Footer({ health }: { health: HealthDto | null }): React.ReactElement {
  return (
    <footer style={{ marginTop: 26, color: '#5c6b7a', fontSize: 11.5, lineHeight: 1.7 }}>
      <div>
        Data is read from a local SQLite database populated by this project's indexer. Prices are derived
        from the pool's <code>sqrtPriceX96</code> with decimals corrected for WETH (18) and USDC (6), and
        cross-checked against the independently derived <code>tick</code> value on every row.
      </div>
      <div style={{ marginTop: 6 }}>
        Not investment advice. No wallet connection, no transactions, read-only public data
        {health?.lastIndexedBlock ? ` up to block ${health.lastIndexedBlock.toLocaleString()}` : ''}.
      </div>
    </footer>
  );
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function compact(n: number): string {
  if (!Number.isFinite(n)) return '—';
  const abs = Math.abs(n);
  if (abs >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return n.toFixed(2);
}

function short(hex: string): string {
  return hex.length > 12 ? `${hex.slice(0, 6)}…${hex.slice(-4)}` : hex;
}
