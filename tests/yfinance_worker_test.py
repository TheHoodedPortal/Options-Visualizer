import datetime
import pathlib
import sys
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / "src"))
from yfinance_worker import market_snapshot, error_code


class Frame:
    def __init__(self, rows):
        self.rows = rows

    def to_dict(self, orient):
        if orient != "records":
            raise ValueError("unexpected orientation")
        return self.rows


class OptionSet:
    underlying = {
        "regularMarketPrice": 1047.6,
        "regularMarketPreviousClose": 1038.2,
        "currency": "USD",
        "trailingAnnualDividendYield": 1.5 / 1047.6,
        "regularMarketTime": 1791590400,
        "marketState": "REGULAR",
        "fullExchangeName": "Nasdaq",
    }
    calls = Frame([
        {
            "contractSymbol": "MU261120C01050000",
            "strike": 1050,
            "contractSize": "REGULAR",
            "bid": 62,
            "ask": 64,
            "lastPrice": 62.5,
            "impliedVolatility": 0.46,
            "volume": 12,
            "openInterest": 103,
        },
        {"contractSymbol": "MINI", "strike": 1050, "contractSize": "MINI"},
        {"contractSymbol": "INVALID", "strike": 0, "contractSize": "REGULAR"},
    ])
    puts = Frame([
        {
            "contractSymbol": "MU261120P01050000",
            "strike": 1050,
            "contractSize": "REGULAR",
            "bid": 65,
            "ask": 67,
            "lastPrice": 66,
            "impliedVolatility": 0.48,
            "volume": 3,
            "openInterest": 21,
        }
    ])


class FakeTicker:
    options = ("2026-11-20", "2026-12-18")

    def __init__(self):
        self.requested_expirations = []

    def option_chain(self, expiration=None):
        self.requested_expirations.append(expiration or "nearest")
        return OptionSet()

    @property
    def fast_info(self):
        raise AssertionError("fast_info should not be requested when the option payload contains a quote")

    def history(self, **kwargs):
        raise AssertionError("history should not be requested when the option payload contains a quote")


class FakeYFinance:
    def __init__(self):
        self.tickers = []

    def Ticker(self, symbol):
        ticker = FakeTicker()
        self.tickers.append((symbol, ticker))
        return ticker


class YFinanceWorkerTests(unittest.TestCase):
    def test_reuses_nearest_chain_quote_and_standard_calls_puts(self):
        yf = FakeYFinance()
        result = market_snapshot(
            yf, {}, "MU", "2026-11-20", today=datetime.date(2026, 10, 10)
        )

        self.assertEqual(result["selectedExpiration"], "2026-11-20")
        self.assertEqual(result["expirations"], ["2026-11-20", "2026-12-18"])
        self.assertEqual(result["quote"]["last"], 1047.6)
        self.assertAlmostEqual(result["quote"]["change_percentage"], 9.4 / 1038.2 * 100)
        self.assertAlmostEqual(result["quote"]["dividendYield"], 1.5 / 1047.6)
        self.assertEqual(result["quote"]["dividendYieldSource"], "Yahoo Finance trailing dividend yield")
        self.assertEqual(result["quote"]["marketState"], "REGULAR")
        self.assertEqual(result["quote"]["exchange"], "Nasdaq")
        self.assertEqual([row["type"] for row in result["chain"]], ["call", "put"])
        self.assertEqual(result["chain"][0]["volume"], 12)
        self.assertEqual(result["chain"][0]["bid"], 62)
        self.assertEqual(yf.tickers[0][1].requested_expirations, ["nearest"])

    def test_uses_the_nearest_future_expiration_for_an_unlisted_preference(self):
        yf = FakeYFinance()
        result = market_snapshot(
            yf, {}, "MU", "2026-11-13", today=datetime.date(2026, 10, 10)
        )

        self.assertEqual(result["selectedExpiration"], "2026-11-20")
        self.assertEqual(yf.tickers[0][1].requested_expirations, ["nearest"])

    def test_requests_a_second_chain_only_for_a_different_expiration(self):
        yf = FakeYFinance()
        cache = {}
        market_snapshot(yf, cache, "MU", "2026-11-20", today=datetime.date(2026, 10, 10))
        market_snapshot(yf, cache, "MU", "2026-12-18", today=datetime.date(2026, 10, 10))

        self.assertEqual(len(yf.tickers), 1)
        self.assertEqual(yf.tickers[0][1].requested_expirations, ["nearest", "2026-12-18"])

    def test_explicit_expiration_uses_cached_yfinance_date_mapping(self):
        class CachedTicker(FakeTicker):
            _expirations = {"2026-11-20": 1, "2026-12-18": 2}
        class CachedFinance(FakeYFinance):
            def Ticker(self, symbol):
                ticker = CachedTicker()
                self.tickers.append((symbol, ticker))
                return ticker
        yf = CachedFinance()
        result = market_snapshot(yf, {}, "MU", "2026-12-18", today=datetime.date(2026, 10, 10))
        self.assertEqual(result["selectedExpiration"], "2026-12-18")
        self.assertEqual(yf.tickers[0][1].requested_expirations, ["2026-12-18"])

    def test_requests_current_expiration_when_undated_chain_is_stale(self):
        class StaleTicker(FakeTicker):
            options = ("2026-10-01", "2026-11-20", "2026-12-18")

        class StaleFinance(FakeYFinance):
            def Ticker(self, symbol):
                ticker = StaleTicker()
                self.tickers.append((symbol, ticker))
                return ticker

        yf = StaleFinance()
        result = market_snapshot(yf, {}, "MU", today=datetime.date(2026, 10, 10))
        self.assertEqual(result["selectedExpiration"], "2026-11-20")
        self.assertEqual(yf.tickers[0][1].requested_expirations, ["nearest", "2026-11-20"])

    def test_rejects_all_expired_contracts(self):
        with self.assertRaisesRegex(ValueError, "no current option expirations"):
            market_snapshot(FakeYFinance(), {}, "MU", today=datetime.date(2027, 1, 1))

    def test_rate_limit_error_class_is_structured(self):
        class YFRateLimitError(Exception):
            pass
        self.assertEqual(error_code(YFRateLimitError("blocked")), "rate_limited")
        self.assertIsNone(error_code(ValueError("line 1429")))

    def test_ambiguous_dividend_yield_is_not_assumed_to_be_fraction(self):
        class OptionSetWithYield(OptionSet):
            underlying = {"regularMarketPrice": 100, "dividendYield": 40}
        class YieldTicker(FakeTicker):
            def option_chain(self, expiration=None): return OptionSetWithYield()
        class YieldFinance(FakeYFinance):
            def Ticker(self, symbol): return YieldTicker()
        result = market_snapshot(YieldFinance(), {}, "ABC", today=datetime.date(2026, 10, 10))
        self.assertIsNone(result["quote"]["dividendYield"])

    def test_force_refresh_reloads_nearest_chain(self):
        yf = FakeYFinance()
        cache = {}
        market_snapshot(yf, cache, "MU", today=datetime.date(2026, 10, 10))
        market_snapshot(yf, cache, "MU", today=datetime.date(2026, 10, 10), force_refresh=True)
        self.assertEqual(yf.tickers[0][1].requested_expirations, ["nearest", "nearest"])

    def test_uses_trailing_dividend_rate_when_yield_is_missing(self):
        class RateOnlyOptionSet(OptionSet):
            underlying = {
                "regularMarketPrice": 100,
                "regularMarketPreviousClose": 99,
                "trailingAnnualDividendRate": 2,
            }

        class RateOnlyTicker(FakeTicker):
            def option_chain(self, expiration=None):
                self.requested_expirations.append(expiration or "nearest")
                return RateOnlyOptionSet()

        class RateOnlyFinance(FakeYFinance):
            def Ticker(self, symbol):
                ticker = RateOnlyTicker()
                self.tickers.append((symbol, ticker))
                return ticker

        result = market_snapshot(RateOnlyFinance(), {}, "ABC", today=datetime.date(2026, 10, 10))
        self.assertAlmostEqual(result["quote"]["dividendYield"], 0.02)
        self.assertEqual(result["quote"]["dividendYieldSource"], "Yahoo Finance trailing dividend rate / price")


if __name__ == "__main__":
    unittest.main()
