// Map common region codes (from navigator.language like "en-GB", "de-DE", "ja-JP") to currency codes
const REGION_TO_CURRENCY = {
  US: "USD",
  CA: "CAD",
  GB: "GBP",
  AU: "AUD",
  NZ: "NZD",
  JP: "JPY",
  CN: "CNY",
  IN: "INR",
  KR: "KRW",
  CH: "CHF",
  SE: "SEK",
  NO: "NOK",
  DK: "DKK",
  BR: "BRL",
  MX: "MXN",
  DE: "EUR",
  FR: "EUR",
  ES: "EUR",
  IT: "EUR",
  NL: "EUR",
  IE: "EUR",
  PT: "EUR",
  AT: "EUR",
  BE: "EUR",
  FI: "EUR",
};

// navigator.language can be a tag the Intl APIs reject (e.g. "en-US@posix" on some Linux setups).
// Returns a locale that is safe to pass to toLocaleString(), or undefined for the runtime default.
export function safeLocale() {
  try {
    return Intl.NumberFormat.supportedLocalesOf(navigator.language)[0];
  } catch {
    return undefined;
  }
}

export function getLocalCurrency() {
  try {
    // Extract region from browser locale (e.g., "en-CA" -> "CA")
    const locale = new Intl.Locale(safeLocale() ?? "en-US");
    if (locale.region && REGION_TO_CURRENCY[locale.region]) {
      return REGION_TO_CURRENCY[locale.region];
    }
  } catch {
    // Fallback if Intl.Locale fails
  }
  return "USD";
}

// Cache exchange rates for 5 minutes so multiple cards share one fetch
const rateCache = {};

export async function getExchangeRate(fromCurrency, toCurrency) {
  if (!fromCurrency || !toCurrency || fromCurrency === toCurrency) {
    return 1;
  }

  const pair = `${fromCurrency}${toCurrency}=X`; // e.g., "USDEUR=X"
  const cached = rateCache[pair];
  if (cached && Date.now() - cached.timestamp < 5 * 60 * 1000) {
    return cached.rate;
  }

  try {
    const res = await fetch(`/api/stock?symbol=${pair}&range=1d&interval=1h`);
    const json = await res.json();
    const rate = json?.chart?.result?.[0]?.meta?.regularMarketPrice || 1;

    rateCache[pair] = { rate, timestamp: Date.now() };
    return rate;
  } catch {
    return 1; // Fallback to unconverted price if rate lookup fails
  }
}
