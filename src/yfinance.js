const CACHE_TTL_MS = 5 * 60_000;

export class YFinanceClient {
  constructor(fetcher = (...args) => fetch(...args)) {
    this.fetcher = fetcher;
    this.provider = 'yfinance';
    this.pending = new Map();
    this.cache = new Map();
  }

  key(symbol, expiration) {
    return String(symbol).toUpperCase() + ':' + (expiration || 'nearest');
  }

  async request(symbol, expiration = '', { signal, forceRefresh = false } = {}) {
    const normalizedSymbol = String(symbol || '').trim().toUpperCase();
    const key = this.key(normalizedSymbol, expiration);
    const cached = this.cache.get(key);
    if (!forceRefresh && cached && cached.expiresAt > Date.now()) return cached.data;
    if (!signal && !forceRefresh && this.pending.has(key)) return this.pending.get(key);

    const pending = this.load(normalizedSymbol, expiration, key, signal, forceRefresh);
    if (!signal && !forceRefresh) this.pending.set(key, pending);
    try { return await pending; }
    finally { if (!signal && !forceRefresh) this.pending.delete(key); }
  }

  async load(symbol, expiration, key, signal, forceRefresh) {
    const url = new URL('/api/yfinance', location.origin);
    url.searchParams.set('symbol', symbol);
    if (expiration) url.searchParams.set('expiration', expiration);
    if (forceRefresh) url.searchParams.set('refresh', '1');

    let response;
    try {
      response = await this.fetcher(url.href, { cache: 'no-store', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(45_000)]) : AbortSignal.timeout(45_000) });
    } catch (error) {
      if (error.name === 'AbortError') throw error;
      if (error.name === 'TimeoutError') throw new Error('Yahoo Finance took too long to respond. Wait a moment before trying again.');
      throw new Error('Could not reach the local yfinance connector: ' + error.message);
    }

    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || 'yfinance could not return data for ' + symbol + '.');
    if (!body.quote || !Array.isArray(body.expirations) || !Array.isArray(body.chain)) {
      throw new Error('The local yfinance connector returned incomplete market data.');
    }

    if (forceRefresh) for (const cachedKey of this.cache.keys()) if (cachedKey.startsWith(symbol + ':')) this.cache.delete(cachedKey);
    const entry = { data: body, expiresAt: Date.now() + CACHE_TTL_MS };
    this.cache.set(key, entry);
    if (body.selectedExpiration) this.cache.set(this.key(symbol, body.selectedExpiration), entry);
    return body;
  }

  async loadSymbol(symbol, preferredExpiration = '', options = {}) {
    return this.request(symbol, preferredExpiration, options);
  }

  async quote(symbol) {
    return (await this.request(symbol)).quote;
  }

  async expirations(symbol) {
    return (await this.request(symbol)).expirations;
  }

  async chain(symbol, expiration, options = {}) {
    const data = await this.request(symbol, expiration, options);
    if (expiration && data.selectedExpiration !== expiration) throw new Error('The requested expiration is no longer available. Reload market data to see current expirations.');
    return data.chain;
  }

  async history() {
    return [];
  }
}
