const configuredBase = import.meta.env.BASE_URL.replace(/\/+$/, "");

export const APP_BASE = configuredBase === "/" ? "" : configuredBase;

export function appPath(path = "/"): string {
  const suffix = path.startsWith("/") ? path : `/${path}`;
  return `${APP_BASE}${suffix}` || "/";
}

export function stripAppBase(pathname: string): string {
  if (!APP_BASE) return pathname;
  if (pathname === APP_BASE) return "/";
  return pathname.startsWith(`${APP_BASE}/`) ? pathname.slice(APP_BASE.length) : pathname;
}
