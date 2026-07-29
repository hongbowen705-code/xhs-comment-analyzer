import type { CaptureLimit } from "@xhs/shared";

export function maxCaptureCycles(limit: CaptureLimit): number {
  if (limit === 3000) return 1800;
  if (limit === 2000) return 1200;
  if (limit === 1000) return 720;
  return limit === 500 ? 360 : limit === 100 ? 120 : 60;
}

export function noNewCycleThreshold(limit: CaptureLimit): number {
  return limit >= 1000 ? 20 : limit === 50 ? 10 : 15;
}
