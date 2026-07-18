const HUNTSVILLE = Object.freeze({
  name: "Huntsville, Alabama",
  latitude: 34.7304,
  longitude: -86.5861,
  timeZone: "America/Chicago"
});

const CACHE_TTL_MS = 10 * 60 * 1000;

function weatherCondition(code) {
  if (code === 0) return { label: "Clear", tone: "clear" };
  if (code === 1) return { label: "Mainly Clear", tone: "clear" };
  if (code === 2) return { label: "Partly Cloudy", tone: "cloud" };
  if (code === 3) return { label: "Cloudy", tone: "cloud" };
  if (code === 45 || code === 48) return { label: "Foggy", tone: "fog" };
  if ([51, 53, 55].includes(code)) return { label: "Drizzle", tone: "rain" };
  if ([56, 57].includes(code)) return { label: "Freezing Drizzle", tone: "ice" };
  if ([61, 63, 65].includes(code)) return { label: "Rainy", tone: "rain" };
  if ([66, 67].includes(code)) return { label: "Freezing Rain", tone: "ice" };
  if ([71, 73, 75, 77].includes(code)) return { label: "Snowy", tone: "snow" };
  if ([80, 81, 82].includes(code)) return { label: "Rain Showers", tone: "rain" };
  if ([85, 86].includes(code)) return { label: "Snow Showers", tone: "snow" };
  if ([95, 96, 99].includes(code)) return { label: "Thunderstorms", tone: "storm" };
  return { label: "Conditions Unknown", tone: "unknown" };
}

function weatherUrl() {
  const url = new URL("https://api.open-meteo.com/v1/forecast");
  url.searchParams.set("latitude", HUNTSVILLE.latitude);
  url.searchParams.set("longitude", HUNTSVILLE.longitude);
  url.searchParams.set("current", "temperature_2m,weather_code,is_day");
  url.searchParams.set("temperature_unit", "fahrenheit");
  url.searchParams.set("timezone", HUNTSVILLE.timeZone);
  url.searchParams.set("forecast_days", "1");
  return url.toString();
}

class WeatherService {
  constructor(netFetch) {
    this.netFetch = netFetch;
    this.cached = null;
  }

  async current(force = false) {
    if (!force && this.cached && Date.now() - new Date(this.cached.fetchedAt).getTime() < CACHE_TTL_MS) {
      return { ...this.cached, cached: true };
    }

    try {
      const response = await this.netFetch(weatherUrl(), {
        headers: { "User-Agent": "The-Last-Hour-Weather" }
      });
      if (!response.ok) throw new Error(`Weather service returned ${response.status}.`);
      const payload = await response.json();
      const temperature = Number(payload.current?.temperature_2m);
      const weatherCode = Number(payload.current?.weather_code);
      if (!Number.isFinite(temperature) || !Number.isFinite(weatherCode)) {
        throw new Error("Weather service returned incomplete current conditions.");
      }
      const condition = weatherCondition(weatherCode);
      this.cached = {
        location: HUNTSVILLE.name,
        timeZone: HUNTSVILLE.timeZone,
        temperature: Math.round(temperature),
        temperatureUnit: "°F",
        condition: condition.label,
        tone: condition.tone,
        isDay: payload.current?.is_day === 1,
        observedAt: payload.current?.time || "",
        fetchedAt: new Date().toISOString()
      };
      return { ...this.cached, cached: false };
    } catch (error) {
      if (this.cached) return { ...this.cached, cached: true, stale: true, error: error.message };
      throw error;
    }
  }
}

module.exports = { HUNTSVILLE, WeatherService, weatherCondition, weatherUrl };
