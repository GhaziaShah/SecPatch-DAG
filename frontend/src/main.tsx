import { StrictMode, useEffect, useState, type FormEvent, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";
import { MaintenanceStudy } from "./MaintenanceStudy";

const API = import.meta.env.VITE_API_URL ?? "http://127.0.0.1:8000/api/v1";
type Project = { id: string; name: string; description?: string | null };
type Environment = { id: string; project_id: string; name: string; description?: string | null };
type Asset = { id: string; environment_id: string; name: string; external_identifier?: string; operating_system?: string };
type InventoryRow = { id: string; asset_id?: string; version: string | null; package?: string; ecosystem?: string };
type PackageCheck = { asset: string; package: string; ecosystem: string; version: string | null; status: "affected" | "unaffected" | "unknown" | "no_match"; fixes: string[] };
type Candidate = { id: string; candidate_key?: string; vulnerability_id?: string; aliases: string[]; package?: string; ecosystem?: string; installed_version?: string | null; fixed_version?: string | null; applicability: string; unresolved_issues: string[] };
type Graph = { nodes?: string[]; edges?: Array<{ from: string; to: string }>; strongly_connected_components?: string[][]; cyclic_components?: string[][]; blocked_packages?: string[]; topological_order?: string[]; trace?: Trace[]; dependency_analysis?: { analysis?: { blocked_nodes?: string[] } } };
type Trace = { algorithm?: string; event?: string; node?: string; nodes?: string[]; component?: string; action?: string; reason?: string; [key: string]: unknown };
type Action = { id: string; package_id?: string; duration_minutes: number; benefit: number; priority?: number };
type Analysis = {
  comparison_id?: string; estimate_source?: string;
  method?: string; window_minutes?: number; selected_count?: number; used_minutes?: number;
  solver_status?: string; objective_value?: number;
  run_id?: string; status?: string; created_at?: string; graph?: Graph;
  optimization?: { half_bound_applies?: boolean; method?: string; solver_status?: string; optimality_proven?: boolean; objective_value?: number; selected_actions?: Action[]; deferred_actions?: string[]; blocked_actions?: string[]; total_duration_minutes?: number; runtime_ms?: number; comparison?: { objective_delta?: number } };
  schedule?: { total_duration_minutes?: number; entries?: Array<{ action_id: string; start_minute: number; finish_minute: number; duration_minutes: number }> };
  validation?: { valid?: boolean; violations?: string[]; warnings?: string[] };
  persistence?: { analysis_run_id: string; input_snapshot?: Record<string, unknown> };
  configuration?: { window_minutes?: number };
  estimate_review?: { applied?: string[]; ignored?: Record<string, string> };
  trace?: Trace[];
};
type Estimates = Record<string, { duration_minutes: number; benefit: number; priority?: number; [key: string]: unknown }>;
type Tab = "overview" | "assets" | "vulnerabilities" | "graph" | "optimization" | "history" | "cep";
const demoVulnerabilityId = "OSV-DEMO-2026-0001";
const maxWindow = 1440; // must match MAX_DASHBOARD_WINDOW in core/ingestion/limits.py

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API}${path}`, { headers: { "Content-Type": "application/json" }, ...init });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(errorText(body.detail) ?? `Request failed (${response.status})`);
  return body as T;
}
function errorText(detail: unknown): string | undefined {
  if (typeof detail === "string") return detail;
  if (Array.isArray(detail)) return detail.map((item) => String(item?.msg ?? item).replace(/^Value error, /, "")).join("; ");
  return undefined;
}
async function readJson(file: File): Promise<any> {
  try { return JSON.parse(await file.text()); } catch { throw new Error(`${file.name} is not a valid JSON file`); }
}
function download(name: string, content: string, type: string) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const anchor = document.createElement("a"); anchor.href = url; anchor.download = name; anchor.click(); URL.revokeObjectURL(url);
}
function csvCell(cell: string) { const text = /^[=+\-@\t\r]/.test(cell) ? `'${cell}` : cell; return `"${text.split('"').join('""')}"`; }
function csv(rows: string[][]) { return rows.map((row) => row.map((cell) => csvCell(String(cell))).join(",")).join("\n"); }

function App() {
  const [tab, setTab] = useState<Tab>("overview");
  const [projects, setProjects] = useState<Project[]>([]), [project, setProject] = useState<Project | null>(null);
  const [environments, setEnvironments] = useState<Environment[]>([]), [environment, setEnvironment] = useState<Environment | null>(null);
  const [assets, setAssets] = useState<Asset[]>([]), [inventory, setInventory] = useState<InventoryRow[]>([]);
  const [summary, setSummary] = useState<{ package_checks?: PackageCheck[]; vulnerabilities: number; candidates: number; candidate_details: Candidate[]; issues: Array<{ code: string; message: string }> } | null>(null);
  const [analysis, setAnalysis] = useState<Analysis | null>(null), [comparison, setComparison] = useState<{ greedy: Analysis; dp: Analysis; cp_sat: Analysis } | null>(null);
  const [graphAnalysis, setGraphAnalysis] = useState<Analysis | null>(null), [envGraph, setEnvGraph] = useState<Analysis | null>(null);
  const [confirm, setConfirm] = useState<{ title: string; text: string; action: () => Promise<void> } | null>(null);
  const [history, setHistory] = useState<Analysis[]>([]), [windowMinutes, setWindowMinutes] = useState(60);
  const [duration, setDuration] = useState(15), [benefit, setBenefit] = useState(90), [, setCandidateId] = useState("");
  const [estimateFile, setEstimateFile] = useState<{ name: string; values: Estimates } | null>(null);
  const [loading, setLoading] = useState(false), [error, setError] = useState(""), [apiState, setApiState] = useState("checking");
  const [showProject, setShowProject] = useState(false), [showEnvironment, setShowEnvironment] = useState(false), [showAsset, setShowAsset] = useState(false), [editAsset, setEditAsset] = useState<Asset | null>(null);

  // Errors render in a banner at the top of the page; scroll there so a
  // failure is never invisible when the user is further down the page.
  useEffect(() => { if (error) window.scrollTo({ top: 0, behavior: "smooth" }); }, [error]);
  const refreshProjects = async () => { const values = await request<Project[]>("/projects"); setProjects(values); };
  useEffect(() => { refreshProjects().catch((e: Error) => setError(e.message)); request("/health").then(() => setApiState("online")).catch(() => setApiState("offline")); }, []);
  const selectEnvironment = async (value: Environment, projectId = project?.id) => {
    setEnvironment(value); setAnalysis(null); setComparison(null); setGraphAnalysis(null); setEnvGraph(null); if (!projectId) return;
    // Reload stored candidates: without this a page refresh or environment
    // switch left the dashboard with no candidates, and analyses silently
    // ran with a placeholder estimate key and returned an empty plan.
    setSummary(await request<typeof summary>(`/environments/${value.id}/candidates`));
    const projectAssets = await request<Asset[]>(`/environments/${value.id}/assets`);
    setAssets(projectAssets);
    const rows = (await Promise.all(projectAssets.map((asset) => request<InventoryRow[]>(`/assets/${asset.id}/inventory`)))).flat(); setInventory(rows);
    const runs = await request<Array<Analysis & { id?: string }>>(`/projects/${projectId}/analysis-runs?environment_id=${value.id}`);
    setHistory(runs.map((run) => ({ ...run, run_id: run.run_id ?? run.id })));
    setEnvGraph(await request<Analysis>(`/environments/${value.id}/graph`));
  };
  const selectProject = async (value: Project) => { setProject(value); setEnvironment(null); setEnvironments([]); setAssets([]); setInventory([]); setSummary(null); setHistory([]); setEnvGraph(null); setAnalysis(null); setComparison(null); const envs = await request<Environment[]>(`/projects/${value.id}/environments`); setEnvironments(envs); if (envs[0]) await selectEnvironment(envs[0], value.id); };
  const submitProject = async (event: FormEvent<HTMLFormElement>) => { event.preventDefault(); const f = new FormData(event.currentTarget); setLoading(true); try { const created = await request<Project>("/projects", { method: "POST", body: JSON.stringify({ name: f.get("name"), description: f.get("description") || null }) }); await refreshProjects(); await selectProject(created); setShowProject(false); } catch (e) { setError(e instanceof Error ? e.message : "Unable to create project"); } finally { setLoading(false); } };
  const submitEnvironment = async (event: FormEvent<HTMLFormElement>) => { event.preventDefault(); if (!project) return; const f = new FormData(event.currentTarget); setLoading(true); try { const created = await request<Environment>("/environments", { method: "POST", body: JSON.stringify({ project_id: project.id, name: f.get("name"), description: f.get("description") || null }) }); setEnvironments(await request<Environment[]>(`/projects/${project.id}/environments`)); await selectEnvironment(created, project.id); setShowEnvironment(false); } catch (e) { setError(e instanceof Error ? e.message : "Unable to create environment"); } finally { setLoading(false); } };
  const importInventory = async (file: File) => { if (!environment) throw new Error("Select an environment first"); const value = await readJson(file); if (!Array.isArray(value.packages)) throw new Error("Inventory JSON must contain a packages array"); await request("/inventory", { method: "POST", body: JSON.stringify({ environment_id: environment.id, packages: value.packages }) }); await selectEnvironment(environment); };
  const importVulnerabilities = async (file: File) => { if (!environment) throw new Error("Select an environment first"); const osv = await readJson(file); if (!Array.isArray(osv.vulns)) throw new Error("OSV JSON must contain a vulns array"); if (!inventory.length) throw new Error("This environment has no installed packages yet. Import the inventory first, then the OSV file, so vulnerabilities can be matched."); const payload = { packages: inventory.map((row) => ({ asset_id: assets.find((asset) => asset.id === row.asset_id)?.external_identifier, ecosystem: row.ecosystem, name: row.package, version: row.version })) }; const result = await request<typeof summary>("/vulnerabilities/import", { method: "POST", body: JSON.stringify({ environment_id: environment.id, osv, inventory: payload }) }); setSummary(result); if (result?.candidate_details[0]) setCandidateId(result.candidate_details[0].candidate_key ?? result.candidate_details[0].id); };
  const importDependencies = async (file: File) => {
    if (!environment) throw new Error("Select an environment first");
    const value = await readJson(file);
    const edges = Array.isArray(value) ? value : value.dependencies;
    if (!Array.isArray(edges)) throw new Error("Dependencies JSON must contain a dependencies array");
    setEnvGraph(await request<Analysis>("/dependencies", { method: "POST", body: JSON.stringify({ environment_id: environment.id, dependencies: edges }) }));
    setGraphAnalysis(null); setAnalysis(null); setComparison(null);
  };
  const clearWorkspace = () => { setEnvironment(null); setAssets([]); setInventory([]); setSummary(null); setHistory([]); setEnvGraph(null); setAnalysis(null); setComparison(null); setGraphAnalysis(null); };
  const askDeleteProject = () => project && setConfirm({ title: `Delete project "${project.name}"?`, text: "The project, its environments and servers disappear from the dashboard and the name can be reused. Saved plans stay in the database as an audit record.", action: async () => { await request(`/projects/${project.id}`, { method: "DELETE" }); setProject(null); setEnvironments([]); clearWorkspace(); await refreshProjects(); } });
  const askDeleteEnvironment = () => project && environment && setConfirm({ title: `Delete environment "${environment.name}"?`, text: "Its servers and inventory are removed from the dashboard. Saved plans stay in the database as an audit record.", action: async () => { await request(`/environments/${environment.id}`, { method: "DELETE" }); clearWorkspace(); const envs = await request<Environment[]>(`/projects/${project.id}/environments`); setEnvironments(envs); if (envs[0]) await selectEnvironment(envs[0], project.id); } });
  const askDeleteAsset = (asset: Asset) => environment && setConfirm({ title: `Delete server "${asset.name}"?`, text: "Its inventory and vulnerabilities leave new analyses and its identifier can be reused. Past plans in History are kept.", action: async () => { await request(`/assets/${asset.id}`, { method: "DELETE" }); await selectEnvironment(environment); } });
  const estimates = () => {
    const actionable = summary?.candidate_details.filter((candidate) => candidate.applicability === "affected" && candidate.unresolved_issues.length === 0 && candidate.candidate_key);
    if (estimateFile) return estimateFile.values;
    if (!Number.isInteger(duration) || duration <= 0 || !Number.isInteger(benefit) || benefit < 0) throw new Error("Duration must be a positive whole number and benefit a whole number of zero or more");
    if (actionable?.length) {
      return Object.fromEntries(actionable.map((candidate) => [
        candidate.candidate_key,
        { duration_minutes: duration, benefit, priority: benefit },
      ]));
    }
    throw new Error("No actionable candidates in this environment. Import inventory and OSV data first, or upload an estimates file.");
  };
  const run = async (comparisonId: string, method: "cp_sat" | "precedence_greedy" | "dynamic_programming") => { if (!project || !environment) throw new Error("Select a project and an environment in the left sidebar first."); return request<Analysis>("/persisted-plans", { method: "POST", body: JSON.stringify({ project_id: project.id, environment_id: environment.id, window_minutes: windowMinutes, method, comparison_id: comparisonId, estimate_source: estimateFile?.name ?? "Manual estimates", estimates: estimates() }) }); };
  const runComparison = async () => { setLoading(true); setError(""); try { const comparisonId = crypto.randomUUID(); const greedy = await run(comparisonId, "precedence_greedy"); const dp = await run(comparisonId, "dynamic_programming"); const cp_sat = await run(comparisonId, "cp_sat"); if (greedy && dp && cp_sat) { setComparison({ greedy, dp, cp_sat }); setAnalysis(dp.optimization?.solver_status === "OPTIMAL" ? dp : cp_sat); if (project && environment) { const runs = await request<Array<Analysis & { id?: string }>>(`/projects/${project.id}/analysis-runs?environment_id=${environment.id}`); setHistory(runs.map((item) => ({ ...item, run_id: item.run_id ?? item.id }))); } } } catch (e) { setError(e instanceof Error ? e.message : "Comparison failed"); } finally { setLoading(false); } };
  const importEstimates = async (file: File) => {
    const value = await readJson(file);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Estimates JSON must be an object keyed by <asset external identifier>:<vulnerability id>");
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      const entry = item as { duration_minutes?: unknown; benefit?: unknown } | null;
      if (!entry || typeof entry !== "object" || !Number.isInteger(entry.duration_minutes) || !Number.isInteger(entry.benefit)) throw new Error(`Estimate ${key} needs whole-number duration_minutes and benefit`);
    }
    setEstimateFile({ name: file.name, values: value as Estimates });
  };
  const openHistory = async (id: string) => { setLoading(true); try { const saved = await request<Analysis>(`/analysis-runs/${id}`); setComparison(null); setAnalysis(saved); setTab("optimization"); } catch (e) { setError(e instanceof Error ? e.message : "Unable to load analysis"); } finally { setLoading(false); } };
  const exportAnalysis = () => analysis && download("secpatch-analysis.json", JSON.stringify(analysis, null, 2), "application/json");
  const exportPlan = () => analysis && download("secpatch-remediation-plan.csv", csv([["Action", "Package", "Start", "Finish", "Duration", "Benefit"], ...(analysis.schedule?.entries ?? []).map((entry) => { const action = analysis.optimization?.selected_actions?.find((item) => item.id === entry.action_id); return [entry.action_id, action?.package_id ?? "", String(entry.start_minute), String(entry.finish_minute), String(entry.duration_minutes), String(action?.benefit ?? "")]; })]), "text/csv");
  const exportComparison = () => comparison && download("secpatch-comparison.csv", csv([["Method", "Status", "Objective", "Duration", "Selected actions", "Optimality"], ...(["greedy", "dp", "cp_sat"] as const).map((method) => { const result = comparison[method]; return [method, result.optimization?.solver_status ?? "", String(result.optimization?.objective_value ?? 0), String(result.schedule?.total_duration_minutes ?? 0), String(result.optimization?.selected_actions?.length ?? 0), String(Boolean(result.optimization?.optimality_proven))]; })]), "text/csv");
  const setupDemo = async () => {
    setLoading(true); setError("");
    try {
      const suffix = new Date().toISOString().slice(11, 19).replace(/:/g, "");
      const createdProject = await request<Project>("/projects", { method: "POST", body: JSON.stringify({ name: `SecPatch demo ${suffix}`, description: "Synthetic offline demonstration data" }) });
      const createdEnvironment = await request<Environment>("/environments", { method: "POST", body: JSON.stringify({ project_id: createdProject.id, name: "Production-like lab" }) });
      await request("/assets", { method: "POST", body: JSON.stringify({ environment_id: createdEnvironment.id, name: "API host", external_identifier: "asset-api", operating_system: "linux" }) });
      await request("/assets", { method: "POST", body: JSON.stringify({ environment_id: createdEnvironment.id, name: "Worker host", external_identifier: "asset-worker", operating_system: "linux" }) });
      await request("/inventory", { method: "POST", body: JSON.stringify({ environment_id: createdEnvironment.id, packages: [{ asset_id: "asset-api", ecosystem: "PyPI", name: "demo-lib", version: "1.9" }, { asset_id: "asset-worker", ecosystem: "PyPI", name: "demo-lib", version: "1.10.0" }] }) });
      const vulnerability = await request<typeof summary>("/vulnerabilities/import", { method: "POST", body: JSON.stringify({ environment_id: createdEnvironment.id, osv: { vulns: [{ id: demoVulnerabilityId, aliases: ["CVE-2026-0001"], summary: "Synthetic demo vulnerability", affected: [{ package: { ecosystem: "PyPI", name: "demo-lib" }, ranges: [{ type: "ECOSYSTEM", events: [{ introduced: "1.0.0" }, { fixed: "1.10.0" }] }] }] }] }, inventory: { packages: [{ asset_id: "asset-api", ecosystem: "PyPI", name: "demo-lib", version: "1.9" }, { asset_id: "asset-worker", ecosystem: "PyPI", name: "demo-lib", version: "1.10.0" }] } }) });
      const graphResult = await request<Analysis>("/plans", { method: "POST", body: JSON.stringify({ dataset: { packages: [{ id: "web-gateway" }, { id: "auth-service" }, { id: "shared-crypto" }, { id: "payments" }, { id: "billing" }, { id: "ledger" }], dependencies: [{ from: "web-gateway", to: "auth-service" }, { from: "auth-service", to: "shared-crypto" }, { from: "payments", to: "shared-crypto" }, { from: "payments", to: "billing" }, { from: "billing", to: "ledger" }, { from: "ledger", to: "billing" }], actions: [{ id: "patch-crypto", package_id: "shared-crypto", duration_minutes: 20, benefit: 95, priority: 95 }, { id: "patch-auth", package_id: "auth-service", duration_minutes: 25, benefit: 80, priority: 85, prerequisites: ["patch-crypto"] }, { id: "patch-payments", package_id: "payments", duration_minutes: 10, benefit: 70, priority: 70 }] }, window_minutes: windowMinutes, method: "cp_sat" }) });
      await refreshProjects(); await selectProject(createdProject); setSummary(vulnerability); setCandidateId(`asset-api:${demoVulnerabilityId}`); setGraphAnalysis(graphResult); setTab("overview");
    } catch (e) { setError(e instanceof Error ? e.message : "Demo setup failed"); } finally { setLoading(false); }
  };
  const nav: Array<[Tab, string, string]> = [["overview", "Overview", "⌂"], ["assets", "Assets & inventory", "◈"], ["vulnerabilities", "Vulnerabilities", "△"], ["graph", "Dependency graph", "⌘"], ["optimization", "Optimization", "↗"], ["history", "Analysis history", "◷"], ["cep", "Maintenance study", "◇"]];
  const selected = analysis?.optimization?.selected_actions ?? [];
  return <div className="shell">
    <aside className="sidebar"><div className="brand"><div><b>SecPatch-DAG</b><small>Patch planning</small></div></div><div className="workspace-label">Workspace</div><select aria-label="Project" value={project?.id ?? ""} onChange={(e) => { const value = projects.find((item) => item.id === e.target.value); if (value) selectProject(value).catch((x: Error) => setError(x.message)); }}><option value="">Select project</option>{projects.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select><select aria-label="Environment" value={environment?.id ?? ""} disabled={!project} onChange={(e) => { const value = environments.find((item) => item.id === e.target.value); if (value && project) selectEnvironment(value, project.id).catch((x: Error) => setError(x.message)); }}><option value="">Select environment</option>{environments.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select><details className="workspace-settings"><summary>Manage workspace</summary><div className="workspace-actions"><button onClick={() => setShowProject(true)}>+ New project</button><button className={project ? "" : "needs-project"} onClick={() => (project ? setShowEnvironment(true) : setError("Select or create a project first. Every environment belongs to a project."))}>+ New environment</button></div>{project && <div className="workspace-actions danger-actions"><button onClick={askDeleteProject}>Delete project</button><button disabled={!environment} onClick={askDeleteEnvironment}>Delete environment</button></div>}</details><nav>{nav.map(([key, label]) => <button key={key} aria-current={tab === key ? "page" : undefined} className={tab === key ? "active" : ""} onClick={() => setTab(key)}>{label}</button>)}</nav><div className={`sidebar-bottom ${apiState}`}><span className="live-dot" /> API {apiState.toUpperCase()}<small>{environment?.name ?? "No environment selected"}</small></div></aside>
    <main className="content"><header className="topbar"><div><h1>{nav.find(([key]) => key === tab)?.[1]}</h1></div><div className="top-actions"><span className="environment-pill">{project?.name ?? "No project"} <b>/</b> {environment?.name ?? "Select environment"}</span>{tab === "overview" && <button className="button secondary" onClick={setupDemo} disabled={loading}>{loading ? "Preparing…" : "Load demo workspace"}</button>}</div></header>{error && <div className="error-banner"><b>Action failed</b><span>{error}</span><button onClick={() => setError("")}>×</button></div>}
      {tab === "overview" && <Overview analysis={analysis} selected={selected} windowMinutes={windowMinutes} navigate={setTab} />}
      {tab === "assets" && <Assets assets={assets} inventory={inventory} onCreate={() => setShowAsset(true)} onEdit={(asset) => setEditAsset(asset)} onDelete={askDeleteAsset} onImport={(file) => importInventory(file).catch((e) => setError(e instanceof Error ? e.message : "Inventory import failed"))} />}
      {tab === "vulnerabilities" && <Vulnerabilities summary={summary} onImport={(file) => importVulnerabilities(file).catch((e) => setError(e instanceof Error ? e.message : "OSV import failed"))} />}
      {tab === "graph" && <GraphView analysis={graphAnalysis ?? envGraph ?? analysis} canImport={!!environment} onImport={(file) => importDependencies(file).catch((e) => setError(e instanceof Error ? e.message : "Dependency import failed"))} />}
      {tab === "optimization" && <Optimization analysis={analysis} comparison={comparison} windowMinutes={windowMinutes} setWindowMinutes={setWindowMinutes} duration={duration} setDuration={setDuration} benefit={benefit} setBenefit={setBenefit} run={runComparison} loading={loading} exportAnalysis={exportAnalysis} exportPlan={exportPlan} exportComparison={exportComparison} estimateFile={estimateFile?.name ?? null} onEstimateFile={(file) => importEstimates(file).catch((e) => setError(e instanceof Error ? e.message : "Estimates import failed"))} clearEstimateFile={() => setEstimateFile(null)} />}
      {tab === "cep" && <MaintenanceStudy key={analysis?.run_id} api={API} runId={analysis?.run_id} />}
      {tab === "history" && <History runs={history} open={openHistory} />}
      {confirm && <ConfirmDialog {...confirm} onClose={() => setConfirm(null)} onError={setError} />}{showProject && <WorkspaceForm title="Create project" nameLimit={200} onSubmit={submitProject} onClose={() => setShowProject(false)} />}{showEnvironment && <WorkspaceForm title="Create environment" nameLimit={120} onSubmit={submitEnvironment} onClose={() => setShowEnvironment(false)} />}{showAsset && environment && <AssetForm environmentId={environment.id} onDone={() => selectEnvironment(environment).catch((e: Error) => setError(e.message))} onError={(message) => setError(message)} onClose={() => setShowAsset(false)} />}{editAsset && environment && <AssetForm environmentId={environment.id} asset={editAsset} onDone={() => selectEnvironment(environment).catch((e: Error) => setError(e.message))} onError={(message) => setError(message)} onClose={() => setEditAsset(null)} />}
    </main></div>;
}

function Overview({ analysis, selected, windowMinutes, navigate }: { analysis: Analysis | null; selected: Action[]; windowMinutes: number; navigate: (tab: Tab) => void }) {
  const duration = analysis?.schedule?.total_duration_minutes ?? 0;
  const steps: Array<[Tab, string, string]> = [
    ["assets", "Register assets", "Add servers and import their software inventory."],
    ["vulnerabilities", "Match advisories", "Import OSV records and review affected installations."],
    ["graph", "Check dependencies", "Inspect patch order and identify blocked packages."],
    ["optimization", "Compare plans", "Choose a time budget and compare the selected patches."]
  ];
  return <section className="page-stack"><section className="study-entry"><div>
    <h2>Plan two maintenance windows</h2><p>Use the worked example to see which patches fit, then change the available time and compare the schedules.</p>
    <button className="button primary" onClick={() => navigate("cep")}>Open maintenance study →</button></div>
    <dl><dt>Example dataset</dt><dd>12 packages</dd><dd>20 dependencies</dd><dd>2 windows</dd></dl></section>
    <section className="panel"><h3>Plan with your inventory</h3><ol className="workflow">{steps.map(([tab, title, detail]) =>
      <li key={tab}><button onClick={() => navigate(tab)}><b>{title}</b><small>{detail}</small></button></li>)}</ol></section>
    {analysis && <><div className="metric-grid"><Metric label="Selected actions" value={selected.length} note={analysis ? "latest plan" : "awaiting analysis"} tone="green" /><Metric label="Plan duration" value={`${duration}m`} note={`${Math.max(windowMinutes - duration, 0)}m capacity remaining`} /><Metric label="Graph cycles" value={analysis?.graph?.cyclic_components?.length ?? 0} note="SCCs requiring review" tone="orange" /><Metric label="Solver status" value={analysis?.optimization?.solver_status ?? "—"} note={analysis?.optimization?.optimality_proven ? "optimality proven" : "not proven"} tone="cyan" /></div>{analysis ? <Schedule analysis={analysis} /> : <Empty title="No analysis selected" text="Select a workspace and run the comparison to populate operational data." />}</>}</section>; }
function Assets({ assets, inventory, onCreate, onEdit, onDelete, onImport }: { assets: Asset[]; inventory: InventoryRow[]; onCreate: () => void; onEdit: (asset: Asset) => void; onDelete: (asset: Asset) => void; onImport: (file: File) => void }) { return <section className="page-stack"><PageIntro eyebrow="ASSET INVENTORY" title="Servers and installed software" actions={<><button className="button secondary" onClick={onCreate}>Register asset</button><label className="button secondary">Import inventory<input hidden type="file" accept=".json,application/json" onChange={(e) => e.target.files?.[0] && onImport(e.target.files[0])} /></label></>} /><div className="asset-grid">{assets.length ? assets.map((asset) => <article className="asset-card" key={asset.id}><div className="asset-icon">⌁</div><div><b>{asset.name}</b><small>{asset.external_identifier ?? "No identifier"}</small><small>{asset.operating_system || "OS not supplied"}</small></div><button type="button" className="asset-edit" aria-label={`Edit ${asset.name}`} onClick={() => onEdit(asset)}>Edit</button><button type="button" className="asset-edit asset-delete" aria-label={`Delete ${asset.name}`} onClick={() => onDelete(asset)}>Delete</button></article>) : <Empty title="No assets registered" text="Register an asset before importing inventory." />}</div><section className="panel"><PanelTitle eyebrow="INSTALLED SOFTWARE" title="Package inventory" meta={`${inventory.length} records`} />{inventory.length ? <div className="data-table">{inventory.map((row) => <div className="table-row" key={row.id}><b>{row.package ?? "Package"}</b><span>{row.ecosystem ?? "—"}</span><strong>{row.version ?? "unknown"}</strong></div>)}</div> : <Empty title="No inventory loaded" text="Upload a JSON fixture with a packages array." />}</section></section>; }
function PackageCoverage({ rows }: { rows?: PackageCheck[] }) {
  if (!rows) return <p className="muted">Import advisories to see a result for each installed package.</p>;
  const labels = { affected: "Affected", unaffected: "Outside the imported affected ranges", unknown: "Version needs review", no_match: "No matching advisory in this file" };
  const count = (status: PackageCheck["status"]) => rows.filter(row => row.status === status).length;
  const parts = [rows.length + " installed packages checked", count("affected") + " affected", count("no_match") + " with no matching advisory"];
  if (count("unaffected")) parts.push(count("unaffected") + " outside affected ranges");
  if (count("unknown")) parts.push(count("unknown") + " needing review");
  return <section className="panel" style={{ overflowX: "auto" }}>
    <h3>Installed packages · last advisory import</h3><p>{parts.join(" · ")}</p>
    <table className="study-table"><thead><tr><th>Asset</th><th>Package</th><th>Installed version</th><th>Result</th><th>Fixed versions in file</th></tr></thead>
    <tbody>{rows.map(row => <tr key={JSON.stringify([row.asset,row.ecosystem,row.package,row.version])}><td>{row.asset}</td><td>{row.package} <small>{row.ecosystem}</small></td>
      <td>{row.version ?? "Unknown"}</td><td>{labels[row.status]}</td><td>{row.fixes.join(", ") || "—"}</td></tr>)}</tbody></table>
  </section>;
}

function Vulnerabilities({ summary, onImport }: { summary: { package_checks?: PackageCheck[]; vulnerabilities: number; candidates: number; candidate_details: Candidate[]; issues: Array<{ code: string; message: string }> } | null; onImport: (file: File) => void }) { return <section className="page-stack"><PageIntro eyebrow="VULNERABILITY INTELLIGENCE" title="Match advisories to installed packages" actions={<label className="button secondary">Import security advisories<input hidden type="file" accept=".json,application/json" onChange={(e) => { const file = e.target.files?.[0]; if (file) onImport(file); e.target.value = ""; }} /></label>} /><p className="input-guide">Choose a security advisory file in OSV JSON format. For this demo, select <code>baseline/osv_offline.json</code>.</p><PackageCoverage rows={summary?.package_checks} /><section className="panel">{summary ? <><PanelTitle eyebrow="REMEDIATION CANDIDATES" title="Advisories for installed packages" />{summary.candidate_details.length === 0 && <p className="muted">No advisory candidates to review.</p>}{summary.candidate_details.map((candidate) => <div className="candidate-row" key={candidate.id}><div><b>{candidate.vulnerability_id}</b><small>{candidate.package} · installed {candidate.installed_version ?? "unknown"} · fixed {candidate.fixed_version ?? "not supplied"}</small><small>{candidate.aliases.join(", ") || "No aliases"} · {candidate.applicability}</small></div><Status value={candidate.unresolved_issues.length ? "REVIEW" : "ACTIONABLE"} /></div>)}{summary.issues.filter(issue => issue.code !== "package_not_in_inventory").map((issue, i) => <div className="issue-row" key={i}><span className="warning-icon">!</span><div><b>{issue.code}</b><small>{issue.message}</small></div></div>)}</> : <Empty title="No security advisories imported" text="Import the advisory file to check the software versions in your inventory." />}</section></section>; }
function GraphView({ analysis, canImport, onImport }: { analysis: Analysis | null; canImport: boolean; onImport: (file: File) => void }) { const graph = analysis?.graph; const [selected, setSelected] = useState(""); const [order, setOrder] = useState(false); const [zoom, setZoom] = useState(1); const nodes = graph?.nodes ?? []; const edges = graph?.edges ?? []; const blocked = graph?.blocked_packages ?? graph?.dependency_analysis?.analysis?.blocked_nodes ?? []; const blockedSet = new Set(blocked);
  const executionOrder = (graph?.topological_order ?? []).filter(node => !blockedSet.has(node));
  const positions = nodes.map((node, i) => ({ node, x: 70 + (i % 4) * 210, y: 55 + Math.floor(i / 4) * 125 })); const pos = (node: string) => positions.find((item) => item.node === node); return <section className="page-stack"><PageIntro eyebrow="DEPENDENCY INTELLIGENCE" title="Package relationships" actions={<>{canImport && <label className="button secondary">Import dependencies<input hidden type="file" accept=".json,application/json" onChange={(e) => { const file = e.target.files?.[0]; if (file) onImport(file); e.target.value = ""; }} /></label>}<button className="button secondary" onClick={() => setOrder(!order)}>{order ? "Graph view" : "Topological order"}</button>{!order && <><button className="button secondary" onClick={() => setZoom(Math.min(1.7, zoom + .15))}>Zoom +</button><button className="button secondary" onClick={() => setZoom(Math.max(.7, zoom - .15))}>Zoom −</button><button className="button secondary" onClick={() => setZoom(1)}>Fit</button></>}</>} /><div className="graph-layout"><section className="graph-panel">{order ? <div className="order-list">
  <h3>Prerequisite-first order</h3>
  {executionOrder.length ? executionOrder.map((node, i) => (
    <div className="order-row" key={node}>
      <span>{String(i + 1).padStart(2, "0")}</span><b>{node}</b>
    </div>
  )) : <p>{blocked.length ? "Resolve the dependency cycle to schedule packages." : "No packages to order."}</p>}
  {blocked.length > 0 && <section>
    <h3>Blocked by cycle</h3>
    <ul>{blocked.map(node => <li key={node}>{node}</li>)}</ul>
  </section>}
</div> : nodes.length ? <div className="graph-viewport"><svg className="dependency-svg" style={{ transform: `scale(${zoom})`, transformOrigin: "top left" }} viewBox="0 0 900 420" role="img" aria-label="Dependency graph">{edges.map((edge) => { const a = pos(edge.from), b = pos(edge.to); if (!a || !b) return null; const ax = a.x + 75, ay = a.y + 35, dx = b.x + 75 - ax, dy = b.y + 35 - ay; if (!dx && !dy) return <path key={`${edge.from}-${edge.to}`} d={`M${a.x + 110},${a.y} C ${a.x + 140},${a.y - 45} ${a.x + 175},${a.y + 10} ${a.x + 150},${a.y + 22}`} fill="none" className="graph-edge" markerEnd="url(#arrow)" />; const s = Math.min(dx ? 81 / Math.abs(dx) : Infinity, dy ? 41 / Math.abs(dy) : Infinity), len = Math.hypot(dx, dy), back = edges.some((other) => other.from === edge.to && other.to === edge.from), nx = back ? (-dy / len) * 6 : 0, ny = back ? (dx / len) * 6 : 0; return <line key={`${edge.from}-${edge.to}`} x1={ax + dx * s + nx} y1={ay + dy * s + ny} x2={ax + dx * (1 - s) + nx} y2={ay + dy * (1 - s) + ny} className="graph-edge" markerEnd="url(#arrow)" />; })}<defs><marker id="arrow" markerWidth="8" markerHeight="8" refX="7" refY="3" orient="auto"><path d="M0,0 L0,6 L7,3 z" fill="currentColor" /></marker></defs>{positions.map(({ node, x, y }) => { const isBlocked = blocked.includes(node); const cyclic = graph?.cyclic_components?.some((component) => component.includes(node)); return <g key={node} className={`svg-node ${isBlocked && !cyclic ? "blocked" : ""} ${cyclic ? "cyclic" : ""} ${selected === node ? "selected" : ""}`} transform={`translate(${x},${y})`} onClick={() => setSelected(node)}><rect width="150" height="70" rx="8" /><circle cx="18" cy="20" r="5" /><text x="32" y="25">{node}</text><text x="16" y="48">{cyclic ? "SCC / cycle" : isBlocked ? "blocked downstream" : "package node"}</text></g>; })}</svg></div> : <Empty title="No graph available" text="Run an analysis to generate graph data." />}<div className="graph-legend"><span>Solid arrow: dependent → prerequisite</span><span className="legend-critical">Cycle / SCC</span><span className="legend-blocked">Blocked</span></div></section><aside className="algorithm-panel"><PanelTitle eyebrow="ALGORITHM OUTPUT" title="Graph health" meta={`${nodes.length} nodes · ${edges.length} edges`} /><Metric label="Strongly connected components" value={graph?.cyclic_components?.length ?? 0} note="Tarjan cycle groups" tone="orange" /><Metric label="Blocked packages" value={blocked.length} note="cycle impact" tone="orange" /><h4>Cycle membership</h4>{(graph?.cyclic_components ?? []).length ? graph?.cyclic_components?.map((component) => <div className="component-row" key={component.join(",")}>{component.join(" ↔ ")}</div>) : <p className="muted">No cyclic components detected.</p>}{selected && <div className="selected-node"><b>{selected}</b><small>{edges.filter((edge) => edge.from === selected).length} prerequisites · {edges.filter((edge) => edge.to === selected).length} dependents</small></div>}</aside></div></section>; }
function Optimization({ analysis, comparison, windowMinutes, setWindowMinutes, duration, setDuration, benefit, setBenefit, run, loading, exportAnalysis, exportPlan, exportComparison, estimateFile, onEstimateFile, clearEstimateFile }: { analysis: Analysis | null; comparison: { greedy: Analysis; dp: Analysis; cp_sat: Analysis } | null; windowMinutes: number; setWindowMinutes: (v: number) => void; duration: number; setDuration: (v: number) => void; benefit: number; setBenefit: (v: number) => void; run: () => void; loading: boolean; exportAnalysis: () => void; exportPlan: () => void; exportComparison: () => void; estimateFile: string | null; onEstimateFile: (file: File) => void; clearEstimateFile: () => void }) { return <section className="page-stack"><PageIntro eyebrow="OPTIMIZATION CONTROL" title="Single-window comparison" actions={<><button className="button secondary" onClick={exportPlan} disabled={!analysis}>Export plan CSV</button><button className="button secondary" onClick={exportComparison} disabled={!comparison}>Export comparison CSV</button><button className="button secondary" onClick={exportAnalysis} disabled={!analysis}>Export JSON</button></>} /><div className="input-guide"><b>How to run:</b> set the available maintenance time, then either upload an estimates JSON file (for example a dataset's <code>approved_estimates.json</code>) or enter one estimate that is applied to every actionable candidate. Use whole numbers only: <code>duration_minutes</code> must be positive and <code>benefit</code> must be zero or greater. Unknown or blocked candidates are never turned into actions.</div><section className="control-panel"><label>Maintenance window <strong>{windowMinutes} min</strong><input type="range" min="0" max={maxWindow} step="5" value={windowMinutes} onChange={(e) => setWindowMinutes(Number(e.target.value))} /><input type="number" min="0" max={maxWindow} step="1" value={windowMinutes} onChange={(e) => setWindowMinutes(Math.min(maxWindow, Math.max(0, Math.floor(Number(e.target.value) || 0))))} /><small>0 to {maxWindow} min (24 h)</small></label><label>Estimates file{estimateFile ? <><strong>{estimateFile}</strong><button type="button" className="button secondary" onClick={clearEstimateFile}>Use manual values</button></> : <span className="button secondary">Upload JSON<input hidden type="file" accept="application/json,.json" onChange={(e) => { const file = e.target.files?.[0]; if (file) onEstimateFile(file); e.target.value = ""; }} /></span>}<small>Overrides the manual values</small></label><label>Approved duration<input type="number" min="1" step="1" disabled={!!estimateFile} value={duration} onChange={(e) => setDuration(Number(e.target.value))} /><small>Minutes per selected patch</small></label><label>Benefit / priority<input type="number" min="0" step="1" disabled={!!estimateFile} value={benefit} onChange={(e) => setBenefit(Number(e.target.value))} /><small>Risk reduction score</small></label><button className="button primary" onClick={run} disabled={loading}>{loading ? "Solving…" : "Run comparison"} ↗</button></section>{comparison ? <div className="comparison-grid"><ResultCard title="Greedy (ratio)" result={comparison.greedy} /><ResultCard title="Dynamic programming" result={comparison.dp} /><ResultCard title="CP-SAT (reference)" result={comparison.cp_sat} /></div> : analysis?.optimization ? <ResultCard title={methodLabel(analysis.optimization.method)} result={analysis} /> : <Empty title="No comparison yet" text="Enter estimates and run greedy, dynamic programming and CP-SAT against the same workspace." />}{analysis?.estimate_review?.ignored && Object.keys(analysis.estimate_review.ignored).length > 0 && <section className="panel"><PanelTitle eyebrow="ESTIMATE REVIEW" title="Estimates not turned into actions" meta={`${Object.keys(analysis.estimate_review.ignored).length} ignored`} /><div className="selected-list">{Object.entries(analysis.estimate_review.ignored).map(([key, reason]) => <div key={key}><b>{key}</b><span>{reason}</span></div>)}</div></section>}{analysis && <Schedule analysis={analysis} />}</section>; }
function ResultCard({ title, result }: { title: string; result: Analysis }) { const greedy = result.optimization?.method === "precedence_greedy"; return <section className="result-card"><div className="panel-heading"><div><h3>{title}</h3></div><Status value={result.optimization?.solver_status === "INFEASIBLE" ? "INFEASIBLE" : result.validation?.valid === false ? "INVALID PLAN" : greedy && result.optimization?.solver_status === "FEASIBLE" ? (result.optimization?.half_bound_applies ? "APPROXIMATION" : "HEURISTIC") : result.optimization?.solver_status ?? "UNKNOWN"} /></div><div className="result-stats"><Metric label="Objective" value={result.optimization?.objective_value ?? 0} note="benefit" tone="green" /><Metric label="Duration" value={`${result.schedule?.total_duration_minutes ?? 0}m`} note={`${result.optimization?.selected_actions?.length ?? 0} selected`} /><Metric label="Guarantee" value={result.optimization?.optimality_proven ? "EXACT" : result.optimization?.half_bound_applies ? "≥ ½" : "NOT PROVEN"} note={result.optimization?.optimality_proven ? "proven optimal" : result.optimization?.half_bound_applies ? "of the best value (½-approx.)" : result.optimization?.method ?? "—"} tone="cyan" /></div><div className="selected-list">{(result.optimization?.selected_actions ?? []).map((action) => <div key={action.id}><b>{action.id}</b><span>{action.duration_minutes}m · +{action.benefit}</span></div>)}</div>{(result.optimization?.deferred_actions ?? []).length > 0 && <p className="muted">Deferred ({result.optimization?.deferred_actions?.length}): {result.optimization?.deferred_actions?.slice(0, 8).join(", ")}{(result.optimization?.deferred_actions?.length ?? 0) > 8 ? ", ..." : ""}</p>}</section>; }
function Schedule({ analysis }: { analysis: Analysis }) { const entries = analysis.schedule?.entries ?? []; const span = Math.max(analysis.configuration?.window_minutes ?? 0, ...entries.map((entry) => entry.finish_minute), 1); return <section className="panel"><PanelTitle eyebrow="EXECUTION PLAN" title="Maintenance-window schedule" meta={`${analysis.schedule?.total_duration_minutes ?? 0} minutes used`} />{entries.length ? <div className="timeline">{entries.map((entry, i) => <div className="timeline-row" key={entry.action_id}><span>{String(i + 1).padStart(2, "0")}</span><div className="timeline-track"><i style={{ left: `${(entry.start_minute / span) * 100}%`, width: `${Math.max((entry.duration_minutes / span) * 100, 1)}%` }} /></div><b>{entry.action_id}</b><small>{entry.start_minute}–{entry.finish_minute}m</small></div>)}</div> : <Empty title="No scheduled actions" />}{analysis.validation?.violations?.map((violation) => <div className="issue-row" key={violation}><span className="warning-icon">!</span><span>{violation}</span></div>)}<details className="trace"><summary>Algorithm trace ({analysis.trace?.length ?? 0} events)</summary>{(analysis.trace ?? []).map((event, i) => <div key={i}><b>{event.algorithm}</b> {event.event} {event.node ?? event.action ?? event.component ?? ""}</div>)}</details></section>; }
function methodLabel(method?: string) {
  const names: Record<string, string> = {
    precedence_greedy: "Greedy", dynamic_programming: "Dynamic programming", cp_sat: "CP-SAT"
  };
  return method ? names[method] ?? method : "Saved analysis";
}

function SavedComparison({ runs, open }: { runs: Analysis[]; open: (id: string) => void }) {
  const first = runs[0];
  const date = first.created_at && new Date(first.created_at).toLocaleString();
  return <details className="panel">
    <summary style={{cursor: "pointer"}}>
      <strong>{first.window_minutes ?? "?"}-minute window</strong>
      {first.estimate_source && " | " + first.estimate_source}{" | "}{date}
      {" | "}{(first.comparison_id || runs.length > 1) ? runs.length + " of 3 results" : methodLabel(first.method)}
    </summary>
    <div style={{overflowX: "auto"}}>
      <table style={{width: "100%", textAlign: "left", marginTop: "1rem"}}>
        <thead><tr>{["Algorithm", "Selected", "Time used", "Benefit", "Status", "Result"].map(label =>
          <th key={label}>{label}</th>)}</tr></thead>
        <tbody>{runs.map(run => <tr key={run.run_id}>
          <th scope="row">{methodLabel(run.method)}</th>
          <td>{run.selected_count ?? "Unknown"}</td>
          <td>{run.used_minutes == null ? "Unknown" : run.used_minutes + " min"}</td>
          <td>{run.objective_value ?? "Unknown"}</td>
          <td>{run.solver_status ?? run.status}</td>
          <td><button className="button secondary" onClick={() => run.run_id && open(run.run_id)}>View result</button></td>
        </tr>)}</tbody>
      </table>
    </div>
  </details>;
}

function History({ runs, open }: { runs: Analysis[]; open: (id: string) => void }) {
  const earlier: Analysis[][] = [];
  for (let i = 0; i < runs.length; i++) {
    const r = runs[i];
    if (r.comparison_id) continue;
    const trio = runs.slice(i, i + 3);
    const methods = ["cp_sat", "dynamic_programming", "precedence_greedy"];
    const matched = trio.length === 3 && r.window_minutes != null && trio.every((x, j) =>
      !x.comparison_id && x.method === methods[j] && x.window_minutes === r.window_minutes &&
      Math.abs(Date.parse(r.created_at ?? "") - Date.parse(x.created_at ?? "")) <= 2000);
    earlier.push(matched ? trio : [r]);
    if (matched) i += 2;
  }
  const groups = new Map<string, Analysis[]>();
  for (const run of runs) {
    const key = run.comparison_id;
    if (!key) continue;
    const group = groups.get(key);
    if (group) group.push(run);
    else groups.set(key, [run]);
  }
  return <section className="page-stack">
    <PageIntro eyebrow="AUDIT TRAIL" title="Saved comparisons" />
    {Array.from(groups, ([id, group]) =>
      <SavedComparison key={id} runs={group} open={open} />)}
    {earlier.length > 0 && <details className="panel">
      <summary style={{cursor: "pointer"}}>Earlier results ({earlier.length})</summary>
      <p>Earlier comparisons are inferred from the window, save times and algorithm order.</p>
      {earlier.map(group => <SavedComparison key={group[0].run_id} runs={group} open={open} />)}
    </details>}
    {!runs.length && <Empty title="No saved comparisons" text="Run a comparison to save its results here." />}
  </section>;
}
function PageIntro({ title, actions }: { eyebrow: string; title: string; actions?: ReactNode }) { return <div className="section-intro"><div><h2>{title}</h2></div><div className="section-actions">{actions}</div></div>; }
function PanelTitle({ title, meta }: { eyebrow: string; title: string; meta?: string }) { return <div className="panel-heading"><div><h3>{title}</h3></div>{meta && <span className="count-badge">{meta}</span>}</div>; }
function Metric({ label, value, note, tone = "" }: { label: string; value: string | number; note: string; tone?: string }) { return <div className="metric"><span>{label}</span><strong className={tone}>{value}</strong><small>{note}</small></div>; }
function Status({ value }: { value: string }) { return <span className={`status-tag ${value.toLowerCase().split(" ").join("-")}`}>{value}</span>; }
function Empty({ title, text = "Nothing to display yet." }: { title: string; text?: string }) { return <div className="empty-state"><span className="empty-icon">◎</span><h3>{title}</h3><p>{text}</p></div>; }
function ConfirmDialog({ title, text, action, onClose, onError }: { title: string; text: string; action: () => Promise<void>; onClose: () => void; onError: (message: string) => void }) { const [busy, setBusy] = useState(false); const go = async () => { setBusy(true); try { await action(); onClose(); } catch (error) { onError(error instanceof Error ? error.message : "Delete failed"); onClose(); } finally { setBusy(false); } }; return <div className="modal-backdrop"><div className="modal" role="dialog" aria-label={title}><div className="panel-heading"><h3>{title}</h3><button type="button" onClick={onClose}>×</button></div><p className="muted">{text}</p><div className="modal-actions"><button type="button" className="button secondary" onClick={onClose}>Cancel</button><button type="button" className="button danger" disabled={busy} onClick={go}>{busy ? "Deleting…" : "Delete"}</button></div></div></div>; }
function WorkspaceForm({ title, nameLimit, onSubmit, onClose }: { title: string; nameLimit: number; onSubmit: (e: FormEvent<HTMLFormElement>) => void; onClose: () => void }) { return <div className="modal-backdrop"><form className="modal" onSubmit={onSubmit}><div className="panel-heading"><h3>{title}</h3><button type="button" onClick={onClose}>×</button></div><label>Name<input name="name" required maxLength={nameLimit} autoFocus /></label><label>Description<input name="description" maxLength={2000} /></label><div className="modal-actions"><button type="button" className="button secondary" onClick={onClose}>Cancel</button><button className="button primary">Create</button></div></form></div>; }
function AssetForm({ environmentId, asset, onDone, onError, onClose }: { environmentId: string; asset?: Asset; onDone: () => void; onError: (message: string) => void; onClose: () => void }) { const submit = async (e: FormEvent<HTMLFormElement>) => { e.preventDefault(); const f = new FormData(e.currentTarget); const body = { name: String(f.get("name") ?? "").trim(), external_identifier: String(f.get("external_identifier") ?? "").trim(), operating_system: String(f.get("operating_system") ?? "").trim() }; try { if (asset) { await request(`/assets/${asset.id}`, { method: "PATCH", body: JSON.stringify(body) }); } else { await request("/assets", { method: "POST", body: JSON.stringify({ environment_id: environmentId, ...body, operating_system: body.operating_system || null }) }); } onDone(); onClose(); } catch (error) { onError(error instanceof Error ? error.message : asset ? "Unable to update asset" : "Unable to register asset"); } }; return <div className="modal-backdrop"><form className="modal" onSubmit={submit}><div className="panel-heading"><h3>{asset ? "Edit asset" : "Register asset"}</h3><button type="button" onClick={onClose}>×</button></div><label>Name<input name="name" required maxLength={200} defaultValue={asset?.name ?? ""} /></label><label>External identifier<input name="external_identifier" required maxLength={255} defaultValue={asset?.external_identifier ?? ""} /></label>{asset && <small className="muted">Inventory stays linked to this server. Changing the identifier changes its estimate keys (identifier:vulnerability).</small>}<label>Operating system<input name="operating_system" maxLength={120} defaultValue={asset?.operating_system ?? ""} /></label><button className="button primary">{asset ? "Save changes" : "Register"}</button></form></div>; }
createRoot(document.getElementById("root")!).render(<StrictMode><App /></StrictMode>);
