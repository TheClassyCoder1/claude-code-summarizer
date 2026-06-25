import type { Aggregates } from "@/lib/featureTypes";
import { formatTokens, formatUsd } from "@/lib/format";

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-slate-200 bg-white px-4 py-3 shadow-sm">
      <div className="text-xs uppercase tracking-wide text-slate-400">{label}</div>
      <div className="mt-1 text-2xl font-bold text-slate-800">{value}</div>
    </div>
  );
}

export default function StatsHeader({ stats }: { stats: Aggregates }) {
  return (
    <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
      <Stat label="Features" value={String(stats.features)} />
      <Stat label="Projects" value={String(stats.projects)} />
      <Stat label="Output tokens" value={formatTokens(stats.totalOutputTokens)} />
      <Stat label="Est. cost" value={formatUsd(stats.totalCostUsd)} />
    </div>
  );
}
