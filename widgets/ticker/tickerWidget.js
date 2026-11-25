
import {
  getLocalCurrency,
  getExchangeRate,
  safeLocale,
} from "../utils/currency.js";
import { fitText } from "../utils/fitText.js";
import { renderChart } from "../utils/chartRenderer.js";

export const type = "ticker";
export const css = "/static/css/cards/ticker.css";

const POPULAR = [
  ["AAPL", "Apple"],
  ["MSFT", "Microsoft"],
  ["GOOGL", "Alphabet"],
  ["AMZN", "Amazon"],
  ["NVDA", "NVIDIA"],
  ["META", "Meta Platforms"],
  ["TSLA", "Tesla"],
  ["BRK-B", "Berkshire Hathaway"],
  ["JPM", "JPMorgan Chase"],
  ["V", "Visa"],
  ["WMT", "Walmart"],
  ["XOM", "Exxon Mobil"],
  ["SPY", "SPDR S&P 500 ETF"],
  ["VOO", "Vanguard S&P 500 ETF"],
  ["QQQ", "Invesco QQQ"],
  ["VTI", "Vanguard Total Market"],
  ["DIA", "SPDR Dow Jones ETF"],
  ["IWM", "iShares Russell 2000"],
  ["BTC-USD", "Bitcoin"],
  ["ETH-USD", "Ethereum"],
  ["SOL-USD", "Solana"],
  ["XRP-USD", "XRP"],
  ["DOGE-USD", "Dogecoin"],
  ["^GSPC", "S&P 500 index"],
  ["^DJI", "Dow Jones index"],
  ["^IXIC", "Nasdaq Composite"],
  ["GC=F", "Gold futures"],
  ["CL=F", "Crude oil futures"],
  ["EURUSD=X", "EUR / USD"],
].map(([value, name]) => ({
  value,
  label: `${value} — ${name}`,
}));

const CHART_TYPES = [
  { value: "sparkline", label: "Sparkline" },
  { value: "area", label: "Area" },
  { value: "candlestick", label: "Candlestick" },
  { value: "ohlc", label: "OHLC bars" },
  { value: "bar", label: "Price bars" },
];

const DEFAULTS = {
  symbol: "AAPL",
  range: "7d",
  interval: "1h",
  chartType: "sparkline",
};

export const meta = {
  label: "Stock / Crypto Ticker",
  description: "Displays live market prices and configurable price charts.",

  size: {
    default: { col_span: 2, row_span: 2 },
    min: { col_span: 1, row_span: 1 },
  },

  minRefreshMs: 5000,

  defaults: {
    title: "Stock / Crypto Ticker",
    refreshMs: 15000,
    params: { ...DEFAULTS },
  },

  params: {
    symbol: {
      type: "combobox",
      label: "Ticker",
      options: POPULAR,
      searchUrl: "/api/symbols?q={q}",
      allowCustom: true,
      uppercase: true,
      required: true,
    },

    range: {
      type: "select",
      label: "Range",
      options: ["1d", "5d", "7d", "1mo", "3mo", "6mo", "1y"],
    },

    interval: {
      type: "select",
      label: "Interval",
      options: ["5m", "15m", "30m", "1h", "1d"],
    },

    chartType: {
      type: "select",
      label: "Chart style",
      options: CHART_TYPES,
    },
  },

  summary: (card) => card.params?.symbol ?? DEFAULTS.symbol,
};

// --------------------------------------------------
// Helpers
// --------------------------------------------------

function getChartType(value) {
  return CHART_TYPES.some((option) => option.value === value)
    ? value
    : DEFAULTS.chartType;
}

function formatMoney(value, currency) {
  return value.toLocaleString(safeLocale(), {
    style: "currency",
    currency,
    maximumFractionDigits: 2,
  });
}

function getFiniteValues(values) {
  return values.filter(Number.isFinite);
}

function getChartData(quote, rate) {
  const opens = quote.open || [];
  const highs = quote.high || [];
  const lows = quote.low || [];
  const closes = quote.close || [];

  // Preserve original indices so OHLC values stay aligned.
  return closes.map((close, index) => ({
    open: Number.isFinite(opens[index])
      ? opens[index] * rate
      : NaN,

    high: Number.isFinite(highs[index])
      ? highs[index] * rate
      : NaN,

    low: Number.isFinite(lows[index])
      ? lows[index] * rate
      : NaN,

    close: Number.isFinite(close)
      ? close * rate
      : NaN,
  }));
}

function getPriceRange(market, closes, rate) {
  const valid = getFiniteValues(closes);

  const min = valid.length
    ? valid.reduce((a, b) => Math.min(a, b))
    : 0;

  const max = valid.length
    ? valid.reduce((a, b) => Math.max(a, b))
    : 0;

  return {
    low: (market.regularMarketDayLow ?? min) * rate,
    high: (market.regularMarketDayHigh ?? max) * rate,
  };
}

// --------------------------------------------------
// Card rendering
// --------------------------------------------------

export function render(slots, cardData) {
  const params = {
    ...DEFAULTS,
    ...(cardData.params || {}),
  };

  const symbol = params.symbol;
  const range = params.range;
  const interval = params.interval;
  const chartType = getChartType(params.chartType);

  // Standard template slots.
  if (slots.title) {
    slots.title.textContent = cardData.title ?? meta.label;
  }

  if (slots.subtitle) {
    slots.subtitle.textContent = cardData.subtitle ?? "Loading...";
  }

  if (slots.footer) {
    slots.footer.textContent = cardData.footer ?? "";
  }

  // Main content.
  const wrapper = document.createElement("div");
  wrapper.className = "ticker-widget";

  const header = document.createElement("div");
  header.className = "ticker-header";

  const priceEl = document.createElement("div");
  priceEl.className = "ticker-price";
  priceEl.textContent = "--";

  const changeEl = document.createElement("div");
  changeEl.className = "ticker-change";
  changeEl.textContent = "--";

  header.append(priceEl, changeEl);

  const chartEl = document.createElementNS(
    "http://www.w3.org/2000/svg",
    "svg"
  );

  chartEl.classList.add("ticker-sparkline");
  chartEl.setAttribute("role", "img");
  chartEl.setAttribute("aria-label", `${symbol} price chart`);

  const rangeEl = document.createElement("div");
  rangeEl.className = "ticker-range";

  wrapper.append(header, chartEl, rangeEl);

  slots.main?.append(wrapper);

  // fitText is optional, as main may not exist.
  const fit = slots.main
    ? fitText(priceEl, { container: header })
    : null;

  // --------------------------------------------------
  // Data fetching
  // --------------------------------------------------

  const url = cardData.apiUrl ||
    `/api/stock?symbol=${encodeURIComponent(symbol)}` +
    `&range=${encodeURIComponent(range)}` +
    `&interval=${encodeURIComponent(interval)}`;

  let controller = new AbortController();

  async function update() {
    // Cancel an older request before starting another.
    controller.abort();
    controller = new AbortController();

    try {
      const response = await fetch(url, {
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(`Quote request failed (${response.status})`);
      }

      const json = await response.json();
      const result = json?.chart?.result?.[0];

      if (!result) {
        throw new Error("Invalid chart payload");
      }

      const market = result.meta || {};
      const quote = result.indicators?.quote?.[0] || {};

      // Currency conversion.
      const sourceCurrency = market.currency || "USD";
      const targetCurrency = cardData.currency || getLocalCurrency();

      const rate = await getExchangeRate(
        sourceCurrency,
        targetCurrency
      );

      if (controller.signal.aborted) return;

      // Price calculations.
      const closes = quote.close || [];
      const validCloses = getFiniteValues(closes);

      const fallbackPrice = validCloses.at(-1) ?? 0;

      const rawPrice = market.regularMarketPrice ?? fallbackPrice;

      const price = rawPrice * rate;

      const previousRaw =
        market.chartPreviousClose ??
        market.previousClose ??
        market.regularMarketPrice ??
        fallbackPrice;

      const previousClose = previousRaw * rate;

      const pct = Number.isFinite(market.regularMarketChangePercent)
        ? market.regularMarketChangePercent
        : previousClose
          ? ((price - previousClose) / previousClose) * 100
          : 0;

      const isUp = pct >= 0;

      // Update price.
      priceEl.textContent = formatMoney(price, targetCurrency);
      fit?.update();

      // Update percentage.
      changeEl.textContent =
        `${isUp ? "+" : ""}${pct.toFixed(2)}%`;

      changeEl.className =
        `ticker-change ${isUp ? "is-up" : "is-down"}`;

      wrapper.classList.toggle("is-down-trend", !isUp);

      // Update daily range.
      const { low, high } = getPriceRange(
        market,
        validCloses,
        rate
      );

      rangeEl.textContent =
        `Day: ${formatMoney(low, targetCurrency)} - ` +
        `${formatMoney(high, targetCurrency)}`;

      // Update standard subtitle slot.
      if (slots.subtitle) {
        slots.subtitle.textContent =
          `${isUp ? "Up" : "Down"} ` +
          `(${isUp ? "+" : ""}${pct.toFixed(2)}%)`;
      }

      // Render selected chart.
      if (slots.main) {
        const chartData = getChartData(quote, rate);

        renderChart(chartEl, {
          type: chartType,
          data: chartData,
        });
      }

      // Update standard footer slot.
      if (slots.footer && market.regularMarketTime) {
        const marketDate = new Date(
          market.regularMarketTime * 1000
        );

        slots.footer.textContent =
          `Last trade: ${marketDate.toLocaleTimeString(safeLocale())}`;
      }

    } catch (error) {
      if (error.name === "AbortError") return;

      console.error(`Ticker ${symbol}:`, error);

      priceEl.textContent = "Error";
      changeEl.textContent = "Failed to fetch";

      if (slots.subtitle) {
        slots.subtitle.textContent = "Unavailable";
      }

      if (slots.footer) {
        slots.footer.textContent = "";
      }
    }
  }

  // Initial update.
  update();

  // Periodic refresh.
  const refreshMs = Math.max(
    meta.minRefreshMs,
    Number(cardData.refreshMs) || 15000
  );

  const timer = setInterval(update, refreshMs);

  // Cleanup: called when the card is edited,
  // moved to another type, or removed.
  return () => {
    clearInterval(timer);
    controller.abort();
    fit?.destroy();
  };
}