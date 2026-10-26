import datetime
import json
import math
import sys
import time


def number(value):
    try:
        parsed = float(value)
    except (TypeError, ValueError, OverflowError):
        return None
    return parsed if math.isfinite(parsed) else None


def get_value(source, *keys):
    for key in keys:
        try:
            value = source[key]
        except (KeyError, TypeError, AttributeError):
            continue
        if value is not None:
            return value
    return None


def option_rows(frame, option_type):
    try:
        rows = frame.to_dict(orient="records")
    except (AttributeError, TypeError):
        rows = []
    result = []
    for row in rows:
        strike = number(row.get("strike"))
        if not strike or strike <= 0:
            continue
        if row.get("contractSize") not in (None, "", "REGULAR"):
            continue
        result.append({
            "symbol": str(row.get("contractSymbol") or ""),
            "type": option_type,
            "strike": strike,
            "bid": number(row.get("bid")) or 0,
            "ask": number(row.get("ask")) or 0,
            "last": number(row.get("lastPrice")) or 0,
            "iv": number(row.get("impliedVolatility")) or 0,
            "volume": number(row.get("volume")) or 0,
            "openInterest": number(row.get("openInterest")) or 0,
        })
    return result


def market_snapshot(yf, ticker_cache, symbol, expiration=None, today=None):
    ticker = ticker_cache.pop(symbol, None)
    if ticker is None:
        ticker = yf.Ticker(symbol)
    ticker_cache[symbol] = ticker
    if len(ticker_cache) > 50:
        ticker_cache.pop(next(iter(ticker_cache)))

    # The no-date options response includes the expiration list, underlying
    # quote, and nearest chain. Keep that response briefly so changing expiry
    # does not refetch the same nearest chain.
    nearest_cache = getattr(ticker, "_openstrat_nearest_option_set", None)
    if nearest_cache and time.monotonic() - nearest_cache[0] < 5 * 60:
        nearest_option_set = nearest_cache[1]
    else:
        nearest_option_set = ticker.option_chain()
        ticker._openstrat_nearest_option_set = (time.monotonic(), nearest_option_set)
    raw_expirations = ticker.options or ()
    expirations = sorted({
        str(value) for value in raw_expirations
        if isinstance(value, str) and len(value) == 10 and value[4] == "-" and value[7] == "-"
    })
    if not expirations:
        raise ValueError("Yahoo Finance returned no listed option expirations for " + symbol + ".")

    today_text = (today or datetime.date.today()).isoformat()
    nearest = next((value for value in expirations if value >= today_text), None)
    if nearest is None:
        raise ValueError("Yahoo Finance returned no current option expirations for " + symbol + ".")
    selected = expiration if expiration in expirations else nearest
    # The undated response corresponds to the first listed expiration, which
    # can differ from the first current expiration if stale dates are present.
    option_set = nearest_option_set if selected == expirations[0] else ticker.option_chain(selected)
    chain = option_rows(option_set.calls, "call") + option_rows(option_set.puts, "put")
    if not chain:
        raise ValueError("Yahoo Finance returned no standard option contracts for " + symbol + " " + selected + ".")

    underlying = getattr(option_set, "underlying", None) or getattr(ticker, "_underlying", {}) or {}
    last = number(get_value(underlying, "regularMarketPrice", "currentPrice", "postMarketPrice", "preMarketPrice"))
    previous = number(get_value(underlying, "regularMarketPreviousClose", "previousClose"))
    currency = str(get_value(underlying, "currency") or "")
    if not last or last <= 0:
        # Rare fallback for option payloads without the underlying quote.
        fast = ticker.fast_info
        last = number(get_value(fast, "last_price", "lastPrice"))
        previous = previous or number(get_value(fast, "previous_close", "previousClose"))
        currency = currency or str(get_value(fast, "currency") or "")
    if not last or last <= 0:
        history = ticker.history(period="5d", interval="1d", actions=False, auto_adjust=False)
        try:
            last = number(history["Close"].iloc[-1])
            previous = number(history["Close"].iloc[-2]) if len(history.index) > 1 else previous
        except (AttributeError, IndexError, KeyError, TypeError):
            last = None
    if not last or last <= 0:
        raise ValueError("Yahoo Finance did not return a usable underlying price for " + symbol + ".")

    dividend_yield = number(get_value(underlying, "trailingAnnualDividendYield", "dividendYield"))
    dividend_yield_source = "Yahoo Finance trailing dividend yield" if dividend_yield is not None else None
    if dividend_yield is None:
        dividend_rate = number(get_value(underlying, "trailingAnnualDividendRate", "dividendRate"))
        if dividend_rate is not None and dividend_rate >= 0:
            dividend_yield = dividend_rate / last
            dividend_yield_source = "Yahoo Finance trailing dividend rate / price"

    change = last - previous if previous and previous > 0 else None
    change_percentage = change / previous * 100 if change is not None else None
    return {
        "quote": {
            "symbol": symbol,
            "last": last,
            "change": change,
            "change_percentage": change_percentage,
            "dividendYield": dividend_yield,
            "dividendYieldSource": dividend_yield_source,
            "currency": currency,
            "regularMarketTime": get_value(underlying, "regularMarketTime"),
            "marketState": str(get_value(underlying, "marketState") or ""),
            "exchange": str(get_value(underlying, "fullExchangeName", "exchange") or ""),
        },
        "expirations": expirations,
        "chain": chain,
        "selectedExpiration": selected,
    }


def emit(value):
    sys.stdout.write(json.dumps(value, separators=(",", ":"), allow_nan=False) + "\n")
    sys.stdout.flush()


def main():
    try:
        import yfinance as yf
    except Exception as error:
        emit({
            "kind": "ready",
            "ok": False,
            "error": "Install Python 3.10+ and yfinance with: py -3 -m pip install -r requirements.txt (" + str(error) + ")",
        })
        return

    emit({"kind": "ready", "ok": True})
    ticker_cache = {}
    for line in sys.stdin:
        command = {}
        try:
            command = json.loads(line)
            symbol = str(command.get("symbol", "")).upper()
            expiration = str(command.get("expiration") or "")
            if not symbol or not all(char.isalnum() or char in ".^=-" for char in symbol):
                raise ValueError("Enter a valid ticker symbol.")
            data = market_snapshot(yf, ticker_cache, symbol, expiration or None)
            emit({"id": command.get("id"), "ok": True, "data": data})
        except Exception as error:
            emit({"id": command.get("id") if isinstance(command, dict) else None, "ok": False, "error": str(error)[:500]})


if __name__ == "__main__":
    main()
