"use client";

import { useMemo, useState } from "react";
import { aggregate, type FeatureRecord } from "@/lib/featureTypes";
import StatsHeader from "./StatsHeader";
import FeatureItem from "./FeatureItem";

export default function FeatureDashboard({ records }: { records: FeatureRecord[] }) {
  const projects = useMemo(
    () => [...new Set(records.map((r) => r.projectName))].sort(),
    [records],
  );
  const [project, setProject] = useState<string>("all");

  const filtered = useMemo(
    () => (project === "all" ? records : records.filter((r) => r.projectName === project)),
    [records, project],
  );
  const stats = useMemo(() => aggregate(filtered), [filtered]);

  if (records.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-slate-300 bg-white p-8 text-center">
        <p className="text-sm font-medium text-slate-700">No feature records yet.</p>
        <p className="mx-auto mt-2 max-w-md text-xs text-slate-500">
          Install the Claude Code hook with{" "}
          <code className="rounded bg-slate-100 px-1">node tools/feature-logger/install.mjs</code>,
          then work in any Claude Code session. Records appear in{" "}
          <code className="rounded bg-slate-100 px-1">~/.claude/feature-log/</code>.
        </p>
      </div>
    );
  }

  return (
    <div>
      <StatsHeader stats={stats} />

      {projects.length > 1 && (
        <div className="mb-4 flex items-center gap-2">
          <label className="text-xs font-medium text-slate-500">Project</label>
          <select
            value={project}
            onChange={(e) => setProject(e.target.value)}
            className="rounded border border-slate-300 bg-white px-2 py-1 text-sm focus:border-slate-500 focus:outline-none"
          >
            <option value="all">All projects ({records.length})</option>
            {projects.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        </div>
      )}

      <div className="space-y-3">
        {filtered.map((r) => (
          <FeatureItem key={`${r.projectPath}:${r.sessionId}`} record={r} />
        ))}
      </div>
    </div>
  );
}
