const DEFAULT_SITE_DATA_URL = "https://guc-site-data-system.vercel.app";
const DEFAULT_PREVIEW_SITE_DATA_URL = "https://guc-site-data-system-git-codex-f5e9e7-sam5321051-5955s-projects.vercel.app";

function defaultSiteDataUrl() {
  return process.env.VERCEL_ENV === "preview" ? DEFAULT_PREVIEW_SITE_DATA_URL : DEFAULT_SITE_DATA_URL;
}

function normalizedSiteDataUrl() {
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

module.exports = function handler(_request, response) {
  const config = JSON.stringify({ siteDataUrl: normalizedSiteDataUrl() })
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
  response.setHeader("Content-Type", "application/javascript; charset=utf-8");
  response.setHeader("Cache-Control", "no-store, max-age=0");
  response.setHeader("X-Content-Type-Options", "nosniff");
  return response.status(200).send(`globalThis.GUC_PUBLIC_CONFIG = Object.freeze(${config});`);
};
