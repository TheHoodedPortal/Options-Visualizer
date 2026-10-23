// A small local search index keeps autocomplete fast and avoids Yahoo requests per keystroke.
const popularTickers = [
  ['NVDA', 'NVIDIA'], ['MSFT', 'Microsoft'], ['AAPL', 'Apple'], ['AMZN', 'Amazon'],
  ['GOOGL', 'Alphabet'], ['META', 'Meta Platforms'], ['AVGO', 'Broadcom'], ['TSLA', 'Tesla'],
  ['BRK-B', 'Berkshire Hathaway'], ['LLY', 'Eli Lilly'], ['JPM', 'JPMorgan Chase'], ['WMT', 'Walmart'],
  ['V', 'Visa'], ['XOM', 'Exxon Mobil'], ['MA', 'Mastercard'], ['ORCL', 'Oracle'],
  ['COST', 'Costco'], ['NFLX', 'Netflix'], ['MU', 'Micron Technology'], ['AMD', 'Advanced Micro Devices'],
  ['TSM', 'Taiwan Semiconductor'], ['PLTR', 'Palantir'], ['SPY', 'SPDR S&P 500 ETF'], ['QQQ', 'Invesco QQQ ETF'],
  ['VOO', 'Vanguard S&P 500 ETF'], ['VTI', 'Vanguard Total Stock Market ETF'], ['SCHD', 'Schwab US Dividend Equity ETF'],
  ['MSTR', 'Strategy'], ['COIN', 'Coinbase'], ['HOOD', 'Robinhood'], ['RIVN', 'Rivian'],
  ['INTC', 'Intel'], ['SMCI', 'Super Micro Computer'], ['NVO', 'Novo Nordisk'], ['NKE', 'Nike'],
  ['NET', 'Cloudflare'], ['NEM', 'Newmont'], ['NDAQ', 'Nasdaq'], ['NCLH', 'Norwegian Cruise Line'],
  ['NOC', 'Northrop Grumman'], ['NEE', 'NextEra Energy'], ['NOW', 'ServiceNow'], ['NTR', 'Nutrien'],
  ['NWSA', 'News Corp'], ['NUE', 'Nucor'], ['NIO', 'NIO'], ['NTLA', 'Intellia Therapeutics']
].map(([symbol, name], rank) => ({ symbol, name, rank }));

function matchRank(ticker, query) {
  const symbol = ticker.symbol.toUpperCase();
  const name = ticker.name.toUpperCase();
  if (symbol === query) return 0;
  if (symbol.startsWith(query)) return 1;
  if (name.startsWith(query)) return 2;
  if (symbol.includes(query)) return 3;
  if (name.includes(query)) return 4;
  return Infinity;
}

export function getTickerSuggestions(value, limit = 7) {
  const query = String(value || '').trim().toUpperCase();
  if (!query) return [];
  return popularTickers
    .map(ticker => ({ ticker, match: matchRank(ticker, query) }))
    .filter(result => Number.isFinite(result.match))
    .sort((a, b) => a.match - b.match || a.ticker.rank - b.ticker.rank)
    .slice(0, Math.max(0, limit))
    .map(result => ({ symbol: result.ticker.symbol, name: result.ticker.name }));
}
