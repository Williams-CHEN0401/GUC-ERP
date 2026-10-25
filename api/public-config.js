const DEFAULT_SITE_DATA_URL = "https://guc-site-data-system.vercel.app";
const DEFAULT_PREVIEW_SITE_DATA_URL = "https://guc-site-data-system-git-codex-40c9d1-sam5321051-5955s-projects.vercel.app";
const DEFAULT_PRODUCTION_QUOTATION_URL = "https://guc-quotation-system.vercel.app/";
const DEFAULT_PREVIEW_QUOTATION_URL = "https://guc-quotation-system-g8zwrrbhl-sam5321051-5955s-projects.vercel.app/";
const ALLOWED_QUOTATION_HOSTS = new Set([
  "guc-quotation-system.vercel.app",
  "guc-quotation-system-g8zwrrbhl-sam5321051-5955s-projects.vercel.app",
]);

function defaultSiteDataUrl() {
  return process.env.VERCEL_ENV === "preview" ? DEFAULT_PREVIEW_SITE_DATA_URL : DEFAULT_SITE_DATA_URL;
}

function normalizedSiteDataUrl() {
  if (process.env.GUC_LOCAL_DOCKER === "true") return localDockerUrl(process.env.NEXT_PUBLIC_SITE_DATA_URL);
  const configured = String(process.env.NEXT_PUBLIC_SITE_DATA_URL || "").trim();
  const value = configured || defaultSiteDataUrl();
  if (!value) return "";
  try {
    const url = new URL(value);
    if (url.protocol !== "https:") return "";
    url.username = "";
    url.password = "";
    url.hash = "";
    return url.toString();
  } catch {
    return "";
  }
}

function normalizedQuotationUrl() {
  if (process.env.GUC_LOCAL_DOCKER === "true") return localDockerUrl(process.env.NEXT_PUBLIC_QUOTATION_URL);
  const configured = String(process.env.NEXT_PUBLIC_QUOTATION_URL || "").trim();
  const fallback = process.env.VERCEL_ENV === "production"
    ? DEFAULT_PRODUCTION_QUOTATION_URL
    : process.env.VERCEL_ENV === "preview" ? DEFAULT_PREVIEW_QUOTATION_URL : "";
  const value = configured || fallback;
  if (!value) return "";
  try {
    const url = new URL(value);
    if (url.protocol !== "https:") return "";
    if (!ALLOWED_QUOTATION_HOSTS.has(url.hostname) || url.port) return "";
    if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) return "";
    return url.toString();
  } catch {
    return "";
  }
}

function localDockerUrl(value) {
  try {
    const url = new URL(value);
    const octets = url.hostname.split(".").map(Number);
    const privateIpv4 = octets.length === 4 && octets.every(n => Number.isInteger(n) && n >= 0 && n <= 255)
      && (octets[0] === 10 || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) || (octets[0] === 192 && octets[1] === 168));
    if (!(url.protocol === "https:" || (url.protocol === "http:" && (url.hostname === "localhost" || privateIpv4)))
      || url.username || url.password || url.pathname !== "/" || url.search || url.hash) return "";
    return url.toString();
  } catch { return ""; }
}

// Host selects only a complete, deployment-configured origin profile. Never
// derive token destinations from arbitrary Host or X-Forwarded-Host values.
function dockerOriginProfile(request) {
  if (process.env.GUC_LOCAL_DOCKER !== "true") return null;
  try {
    const profiles = JSON.parse(process.env.GUC_DOCKER_ORIGIN_PROFILES || "[]");
    if (!Array.isArray(profiles)) return null;
    for (const profile of profiles) {
      const urls = ["erp", "site", "quote"].map(key => new URL(profile[key]));
      if (urls.some(url => !["http:", "https:"].includes(url.protocol) || url.username || url.password || url.pathname !== "/" || url.search || url.hash)) continue;
      if (urls[0].host === String(request.headers?.host || "").toLowerCase())
        return { erp: urls[0].href, site: urls[1].href, quote: urls[2].href };
    }
  } catch { /* Invalid deployment profiles do not create a new trusted origin. */ }
  return null;
}

module.exports = function handler(request, response) {
  const localProduction = process.env.GUC_LOCAL_DOCKER === "true"
    && process.env.GUC_LOCAL_SUPABASE === "true"
    && process.env.SUPABASE_FUNCTIONS_URL === "http://guc-supabase-functions:9000"
    && process.env.VERCEL_ENV === "production";
  const profile = dockerOriginProfile(request);
  const productionOrigin = localProduction ? profile?.erp || localDockerUrl(process.env.ERP_PUBLIC_URL || "http://localhost:8080/") : "";
  const config = JSON.stringify({ performanceEnabled: process.env.GUC_PERFORMANCE_ENABLED === "true", siteDataUrl: profile?.site || normalizedSiteDataUrl(), quotationUrl: profile?.quote || normalizedQuotationUrl(), localProduction,
    productionOrigin: productionOrigin ? new URL(productionOrigin).origin : "" })
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
  response.setHeader("Content-Type", "application/javascript; charset=utf-8");
  response.setHeader("Cache-Control", "no-store, max-age=0");
  response.setHeader("X-Content-Type-Options", "nosniff");
  return response.status(200).send(`globalThis.GUC_PUBLIC_CONFIG = Object.freeze(${config});`);
};

