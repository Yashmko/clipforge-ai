export function getApiBaseUrl() {
  return (import.meta.env.VITE_API_BASE_URL || "").replace(/\/$/, "");
}

export function getApiUrl(path: string) {
  return `${getApiBaseUrl()}${path.startsWith("/") ? path : `/${path}`}`;
}
