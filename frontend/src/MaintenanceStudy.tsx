import { useState, type FormEvent } from "react";

type WindowPlan = { capacity: number; minutes: number; schedule: { action_id: string; start_minute: number; finish_minute: number }[] };
type Plan = { benefit: number | null; status: string; windows: WindowPlan[]; rebuilt_groups: string[][]; reused_groups: string[][] };
type Study = { baseline: Plan; sensitivity: Plan; incremental: Plan; removed: string[]; full_ms: number; incremental_ms: number; added_dependencies: string[][] };

export function MaintenanceStudy({ api, runId }: { api: string; runId?: string }) {
  const [study, setStudy] = useState<Study>();
  const [savedPlan, setSavedPlan] = useState<Plan>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function run(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const fields = new FormData(event.currentTarget);
    setBusy(true);
    setError("");
    setStudy(undefined);
    setSavedPlan(undefined);
    try {
      const query = new URLSearchParams({ first: String(fields.get("first")), second: String(fields.get("second")) });
      const saved = fields.get("source") === "saved" && runId;
      const path = saved ? "/analysis-runs/" + runId + "/maintenance-windows" : "/cep/experiment";
      const response = await fetch(api + path + "?" + query);
      if (!response.ok) throw new Error((await response.json()).detail || "Could not run planner");
      const data = await response.json();
      if (saved) setSavedPlan(data);
      else setStudy(data);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Could not reach backend");
    } finally {
      setBusy(false);
    }
  }
  return <section className="panel study">
    <h2>Set the time available</h2>
    <p>Each patch must fit entirely within one window. Use the worked dataset for the demonstration, or choose a saved analysis.</p>
    <form onSubmit={run}>
      <label>Input <select name="source"><option value="demo">Worked dataset</option>
        <option value="saved" disabled={!runId}>Current analysis {runId ? "" : "(run a comparison first)"}</option></select></label>
      <label>First window (minutes) <input required type="number" name="first" min="0" max="1440" defaultValue="18" /></label>
      <label>Second window (minutes) <input required type="number" name="second" min="0" max="1440" defaultValue="13" /></label>
      <button className="button primary" disabled={busy}>{busy ? "Planning…" : "Run experiment"}</button>
    </form>
    {error && <p role="alert">{error}</p>}
    {savedPlan && <section className="result-card"><h3>{savedPlan.status} · {savedPlan.benefit ?? "—"} benefit</h3>
      {savedPlan.windows.map((w, i) => <p key={i}>Window {i+1}: {w.minutes}/{w.capacity} min · {w.schedule.map(x => x.action_id + " (" + x.start_minute + "–" + x.finish_minute + ")").join(" → ") || "No patches selected"}</p>)}</section>}
    {study && <>
      <h3>Compare the three schedules</h3>
      <table className="study-table"><thead><tr><th>Scenario</th><th>Window 1</th><th>Window 2</th><th>Benefit</th></tr></thead>
        <tbody>{([["Baseline", study.baseline], ["After removal", study.sensitivity], ["After dependency changes", study.incremental]] as const).map(([title, plan]) =>
          <tr key={title}><th scope="row">{title}</th>{plan.windows.map((w, i) => <td key={i}>
            <strong>{w.minutes}/{w.capacity} min</strong>
            <ol>{w.schedule.map(x => <li key={x.action_id}>{x.action_id.replace(/^patch-/, "")} <small>{x.start_minute}–{x.finish_minute}</small></li>)}</ol>
            {!w.schedule.length && "No patches"}
          </td>)}<td className="score">{plan.benefit ?? "—"}</td></tr>)}</tbody></table>
      <details className="study-notes"><summary>What changed between runs?</summary>
      <p>The removal test retires {study.removed.join(" and ")}. The dependency test starts again from baseline and adds {study.added_dependencies.map(e => e.join(" → ")).join(", ")}.</p>
      <p>Dependency update: {study.incremental.rebuilt_groups.length} group rebuilt, {study.incremental.reused_groups.length} reused. Incremental {study.incremental_ms} ms · full rebuild {study.full_ms} ms. Both produced the same assignment.</p></details>
    </>}
  </section>;
}
