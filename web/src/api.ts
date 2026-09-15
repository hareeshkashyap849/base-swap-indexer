/**
 * Typed API client.
 *
 * Types mirror the server's response shapes. They are declared here rather than
 * generated from a schema because the surface is four endpoints; if it grew, a
 * shared schema package would be the right answer.
 *
 * Every fetch checks `res.ok` before parsing: without that, an error response
 * (which is JSON, by design — see the API's 404 handler) would be parsed as if
 * it were data and produce a confusing render instead of an error message.
 */

export interface SwapDto {
  blockNumber: number;
  logIndex: number;
  timestamp: number;
  txHash: string;
  sender: string;
  recipient: string;
  amount0: number;
  amount1: number;
  side: 'buy_token0' | 'sell_token0';
  action: 'buy' | 'sell';
  volumeUsdc: number;
  price: number;
  tick: number;
}

export interface StatsDto {
  windowHours: number;
  trades: number;
  volumeUsdc: number;
  vwap: number;
  priceNow: number;
  priceFirst: number;
  changePct: number;
  uniqueTraders: number;
  firstBlock: number | null;
  lastBlock: number | null;
  firstTimestamp: number | null;
  lastTimestamp: number | null;
  low: number;
  high: number;
}

export interface CandleDto {
  ts: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volumeUsdc: number;
  trades: number;
}

export interface HealthDto {
  ok: boolean;
  lastIndexedBlock: number | null;
  chainHead: number | null;
  lag: number | null;
  updatedAt: number | null;
  swaps: number;
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { headers: { accept: 'application/json' } });
  if (!res.ok) {
    let detail = `${res.status} ${res.statusText}`;
    try {
      const body = (await res.json()) as { message?: string; error?: string };
      if (body.message ?? body.error) detail = String(body.message ?? body.error);
    } catch {
      // non-JSON error body; keep the status line
    }
    throw new Error(detail);
  }
  return (await res.json()) as T;
}

export const api = {
  health: () => getJson<HealthDto>('/api/health'),
  stats: (hours: number) => getJson<StatsDto>(`/api/stats?hours=${hours}`),
  ohlcv: (interval: string, hours: number) =>
    getJson<{ interval: string; count: number; candles: CandleDto[] }>(
      `/api/ohlcv?interval=${encodeURIComponent(interval)}&hours=${hours}`,
    ),
  swaps: (limit: number) =>
    getJson<{ count: number; swaps: SwapDto[]; nextCursor: unknown }>(`/api/swaps?limit=${limit}`),
};
