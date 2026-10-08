#!/usr/bin/env node
// Hydrawise API feasibility spike — READ-ONLY. Step 1 of the controller
// monitoring work: before anything is designed, find out what Hunter's two
// APIs actually return for one real controller (the Dundalk one by default).
//
//   node scripts/hydrawise-spike.mjs                         test both APIs against the Dundalk controller
//   node scripts/hydrawise-spike.mjs --controller "King"     match another controller by name or address
//   node scripts/hydrawise-spike.mjs --controller-id 12345   or pick it by Hydrawise controller id
//   node scripts/hydrawise-spike.mjs --days 14               run-history window (default 7, max 31)
//   node scripts/hydrawise-spike.mjs --out <dir>             raw responses land here (default: OS temp dir)
//
// Credentials — env, GitHub secret, or the repo-root .env (never commit them):
//   HYDRAWISE_API_KEY                        REST v1, api.hydrawise.com
//                                            (Hydrawise → menu → Account Details → Generate API Key)
//   HYDRAWISE_USERNAME, HYDRAWISE_PASSWORD   GraphQL v2, app.hydrawise.com (the Hydrawise login)
// Either set alone tests that API; both gives the full picture. In a Claude
// cloud session run it with NODE_USE_ENV_PROXY=1 so fetch uses the proxy.
//
// The two APIs:
//   REST v1  Hunter's documented key API. statusschedule.php gives per-zone run
//            length, seconds to next run, running-now and the sensor list.
//            Capped at 30 calls / 5 min per user; `nextpoll` in each response
//            is the polite gap before the next call.
//   GraphQL  What the Hydrawise app itself talks to — OAuth password grant with
//            the app's public client id, the same way Home Assistant's
//            pydrawise does. Run history with water used, stop reason and
//            solenoid current per run; flow sensors; weather. Rate limit is
//            unpublished, so this spends as few calls as it can.
// Hunter's API terms require their prior written authorization for COMMERCIAL
// use of either API. This spike reads one account once; a production monitor
// needs that authorization (support@hydrawise.com) first.
//
// Nothing here can change a controller: no setzone.php, no GraphQL mutation.
// Call budget per run: REST 2, GraphQL 1 login + up to 7 queries, spaced out.
// Saved responses are redacted (API key, tokens) but still hold customer
// names and addresses — they go to the temp dir, not the repo.
//
// Exit codes: 0 ran (even if a field came back empty) · 1 an API refused or
// failed · 2 not configured / bad input / controller not found.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { loadRepoEnv } from "./lib/gsc-client.mjs";

// Overridable so the script can be exercised against a local stub.
const REST_URL = process.env.HYDRAWISE_REST_URL || "https://api.hydrawise.com/api/v1";
const GRAPHQL_URL = process.env.HYDRAWISE_GRAPHQL_URL || "https://app.hydrawise.com/api/v2/graph";
const TOKEN_URL = process.env.HYDRAWISE_TOKEN_URL || "https://app.hydrawise.com/api/v2/oauth/access-token";

// The Hydrawise app's own public OAuth client (published in pydrawise) — not a PJL secret.
const CLIENT_ID = "hydrawise_app";
const CLIENT_SECRET = "zn3CrjglwNV1";
const APP_VERSION = "pjl-hydrawise-spike";

const TIMEOUT_MS = 30_000;
const GRAPHQL_GAP_MS = Number(process.env.HYDRAWISE_GAP_MS ?? 2000);

// statusschedule.php relay.time sentinels (pydrawise Zone.update_with_json).
const REST_RUNNING_NOW = 1;
const REST_SUSPENDED = 1576800000;
const REST_TYPE_HELD = 110;
const REST_SENSOR_TYPES = { 1: "rain sensor", 2: "flow meter" };

class UsageError extends Error {}
class ApiError extends Error {}

// ---------------------------------------------------------------- queries

const CONTROLLER_FIELDS = `
  id name online
  lastContactTime { value timestamp }
  hardware { serialNumber model { name } }
  location { address locality }`;

const DATE = "{ value timestamp }";
const VAL = "{ value unit }";
const RUN = `{ startTime ${DATE} endTime ${DATE} duration normalDuration remainingTime status { value label } }`;

// One risky thing per query: a failing non-null field nulls the whole
// controller, so weather can never cost us the zones (and so on).
export const QUERIES = {
  account: `query Account {
    me {
      id name email userType customerId
      customer { id organization apiKey }
      controllers { ${CONTROLLER_FIELDS} }
      controllerWatchList { ${CONTROLLER_FIELDS} }
      contractor { id business customers { id organization controllers { ${CONTROLLER_FIELDS} } } }
    }
  }`,

  live: `query Live($id: Int!) {
    controller(controllerId: $id) {
      id name online softwareVersion
      lastContactTime ${DATE}
      hardware { serialNumber version model { name } }
      status { summary online actualWaterTime { value label } normalWaterTime { value label } }
      sensors {
        id name input { number label }
        model { name sensorType divisor flowRate }
        status { active waterFlow ${VAL} }
      }
      zones {
        id name number { value label }
        status { relativeWaterBalance suspendedUntil ${DATE} }
        scheduledRuns {
          summary status currentWaterUsage ${VAL}
          currentRun ${RUN}
          nextRun ${RUN}
        }
        pastRuns { lastRun ${RUN} }
      }
    }
  }`,

  history: `query History($id: Int!, $from: Int!, $until: Int!) {
    controller(controllerId: $id) {
      reports {
        watering(from: $from, until: $until) {
          runEvent {
            id
            zone { id name number { value label } }
            reportedStartTime ${DATE}
            reportedEndTime ${DATE}
            normalDuration scheduledDuration reportedDuration
            reportedStatus { value label }
            reportedWaterUsage ${VAL}
            reportedStopReason { finishedNormally description }
            reportedCurrent ${VAL}
          }
        }
      }
    }
  }`,

  weather: `query Weather($id: Int!) {
    controller(controllerId: $id) {
      observationsSummary {
        currentTemperature ${VAL}
        maxTemperatureSinceMidnight ${VAL}
        rainfallLast24Hours ${VAL}
        rainfallLast168hours ${VAL}
      }
      location {
        currentWeatherObservations {
          time ${DATE}
          temperature ${VAL} windSpeed ${VAL} humidity
          precipitation ${VAL} precipitationLastFewDays ${VAL} precipitationAccumulationPeriod
          evapotranspiration ${VAL}
        }
        forecast(days: 3) {
          time conditions highTemperature ${VAL} lowTemperature ${VAL}
          probabilityOfPrecipitation precipitation ${VAL} averageWindSpeed ${VAL} averageHumidity
        }
      }
      weatherStations {
        id location source distance ${VAL}
        currentObservation {
          time temperature ${VAL} wind ${VAL} windGust ${VAL}
          precipitation ${VAL} precipitationLastHour ${VAL} humidity
        }
      }
    }
  }`,

  totals: `query Totals($id: Int!, $from: Int!, $until: Int!) {
    controller(controllerId: $id) {
      sensors { id name flowSummary(start: $from, end: $until) { totalWaterVolume ${VAL} } }
      zones { id name runSummary { currentWeek { totalNormalRunTime totalActualRunTime totalWaterVolume ${VAL} } } }
    }
  }`,

  alerts: `query Alerts($id: Int!) {
    controller(controllerId: $id) {
      alerts { id eventTime severity message isAlert }
      events(length: 50) { id eventTime severity message isAlert }
      customer {
        alerts {
          id name value unitOfMeasurement valveShutoffActive valveShutoffValue
          alertType { caption category description }
        }
      }
    }
  }`,

  // Deprecated reporting API, and `option` is undocumented — exploratory only.
  charts: `query Charts($id: Int!, $from: Int!, $until: Int!) {
    controller(controllerId: $id) {
      reporting(option: 1, startTime: $from, endTime: $until) {
        solenoidLoadType { title message yaxis results }
        flowRate { title message yaxis results }
      }
    }
  }`,
};

// ---------------------------------------------------------------- plumbing

function parseArgs(argv) {
  const opts = { controller: "dundalk", controllerId: null, days: 7, out: null, help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = () => {
      const v = argv[++i];
      if (v === undefined) throw new UsageError(`${arg} needs a value`);
      return v;
    };
    if (arg === "--controller") opts.controller = value();
    else if (arg === "--controller-id") opts.controllerId = Number(value());
    else if (arg === "--days") opts.days = Number(value());
    else if (arg === "--out") opts.out = value();
    else if (arg === "--help" || arg === "-h") opts.help = true;
    else throw new UsageError(`unknown option ${arg}`);
  }
  if (!Number.isInteger(opts.days) || opts.days < 1 || opts.days > 31) throw new UsageError("--days must be a whole number 1–31");
  if (opts.controllerId !== null && !Number.isInteger(opts.controllerId)) throw new UsageError("--controller-id must be a number");
  return opts;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function httpJson(url, init = {}) {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: res.status, ok: res.ok, body };
}

const SECRET_KEYS = new Set(["apiKey", "api_key", "access_token", "refresh_token", "password"]);

// Deep copy with secrets replaced; an API key keeps only whether it exists.
export function redact(value) {
  if (Array.isArray(value)) return value.map(redact);
  if (!value || typeof value !== "object") return value;
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (!SECRET_KEYS.has(k)) out[k] = redact(v);
    else if (k === "apiKey") out[k] = v ? "[present — redacted]" : v;
    else out[k] = "[redacted]";
  }
  return out;
}

function makeSaver(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return (name, data) => fs.writeFileSync(path.join(dir, `${name}.json`), JSON.stringify(redact(data), null, 2));
}

// ---------------------------------------------------------------- REST v1

async function restGet(apiKey, file, params = {}) {
  const url = new URL(`${REST_URL}/${file}`);
  url.searchParams.set("api_key", apiKey);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
  let res;
  try {
    res = await httpJson(url);
  } catch (err) {
    throw new ApiError(`${file}: could not reach Hydrawise (${err.cause?.code || err.message})`);
  }
  const msg = res.body && typeof res.body === "object" ? res.body.error_msg : null;
  if (!res.ok || msg) throw new ApiError(`${file}: HTTP ${res.status}${msg ? ` — ${msg}` : ""}`);
  if (typeof res.body !== "object") throw new ApiError(`${file}: response was not JSON`);
  return res.body;
}

// Plain reading of one statusschedule.php relay.
export function describeRelay(relay) {
  const runSec = Number(relay.run) || 0;
  if (relay.time === REST_RUNNING_NOW) return { state: "running now", runSec, nextInSec: null };
  if (relay.time === REST_SUSPENDED || relay.type === REST_TYPE_HELD) return { state: "suspended / held off", runSec, nextInSec: null };
  return { state: "scheduled", runSec, nextInSec: Number(relay.time) };
}

// ---------------------------------------------------------------- GraphQL v2

async function graphqlLogin(username, password) {
  const form = new URLSearchParams({
    client_id: CLIENT_ID, client_secret: CLIENT_SECRET,
    grant_type: "password", scope: "all", username, password,
  });
  let res;
  try {
    res = await httpJson(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form,
    });
  } catch (err) {
    throw new ApiError(`login: could not reach Hydrawise (${err.cause?.code || err.message})`);
  }
  const b = typeof res.body === "object" && res.body ? res.body : {};
  if (!res.ok || b.error || !b.access_token) {
    throw new ApiError(`login refused: ${b.message || b.error || `HTTP ${res.status}`}`);
  }
  return `${b.token_type || "Bearer"} ${b.access_token}`;
}

function makeGraphql(authHeader) {
  let calls = 0;
  return async function graphql(name, variables = {}) {
    if (calls++ > 0) await sleep(GRAPHQL_GAP_MS);
    const url = new URL(GRAPHQL_URL);
    url.searchParams.set("appVersion", APP_VERSION);
    let res;
    try {
      res = await httpJson(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: authHeader },
        body: JSON.stringify({ query: QUERIES[name], variables }),
      });
    } catch (err) {
      return { name, status: 0, data: null, errors: [`could not reach Hydrawise (${err.cause?.code || err.message})`] };
    }
    const body = typeof res.body === "object" && res.body ? res.body : {};
    const errors = (body.errors || []).map((e) => e.message || JSON.stringify(e));
    if (!res.ok) errors.unshift(res.status === 429 ? "HTTP 429 — throttled by Hydrawise" : `HTTP ${res.status}`);
    return { name, status: res.status, data: body.data ?? null, errors };
  };
}

// Every controller the login can see, tagged with whose it is.
export function listGraphqlControllers(me) {
  const seen = new Map();
  const add = (c, owner) => { if (c && !seen.has(c.id)) seen.set(c.id, { ...c, owner }); };
  for (const c of me?.controllers || []) add(c, "own account");
  for (const c of me?.controllerWatchList || []) add(c, "watch list");
  for (const cust of me?.contractor?.customers || []) {
    for (const c of cust?.controllers || []) add(c, `customer: ${cust.organization || cust.id}`);
  }
  return [...seen.values()];
}

// Pick one controller by id, else by a case-insensitive match on name/address.
export function pickController(list, { controllerId, controller }) {
  if (controllerId !== null) {
    const hit = list.find((c) => c.id === controllerId || c.controller_id === controllerId);
    return hit ? { hit } : { problem: `no controller with id ${controllerId}` };
  }
  const needle = controller.toLowerCase();
  const text = (c) => [c.name, c.location?.address, c.location?.locality, c.owner].filter(Boolean).join(" ").toLowerCase();
  const matches = list.filter((c) => text(c).includes(needle));
  if (matches.length === 1) return { hit: matches[0] };
  if (matches.length > 1) return { problem: `"${controller}" matches ${matches.length} controllers — pass --controller-id` };
  if (list.length === 1) return { hit: list[0], note: `nothing matched "${controller}"; using the only controller on the account` };
  return { problem: `no controller matched "${controller}"` };
}

// Per-zone flow and current from the run history — the numbers a broken-head
// check would lean on, if they come back populated.
export function summariseRuns(entries) {
  const byZone = new Map();
  for (const { runEvent: r } of entries || []) {
    if (!r) continue;
    const key = r.zone?.id ?? "?";
    if (!byZone.has(key)) byZone.set(key, { zone: r.zone?.name || `zone ${key}`, number: r.zone?.number?.value ?? null, runs: 0, withWater: 0, withCurrent: 0, rates: [], currents: [], unit: null, currentUnit: null, stops: {} });
    const z = byZone.get(key);
    z.runs++;
    const mins = (r.reportedDuration || 0) / 60;
    const water = r.reportedWaterUsage?.value;
    if (water != null) {
      z.withWater++;
      z.unit = r.reportedWaterUsage.unit;
      if (mins > 0) z.rates.push(water / mins);
    }
    if (r.reportedCurrent?.value != null) {
      z.withCurrent++;
      z.currents.push(r.reportedCurrent.value);
      z.currentUnit = r.reportedCurrent.unit;
    }
    const stop = r.reportedStopReason?.description?.join("; ") || "—";
    z.stops[stop] = (z.stops[stop] || 0) + 1;
  }
  const stats = (xs) => xs.length ? { avg: xs.reduce((a, b) => a + b, 0) / xs.length, min: Math.min(...xs), max: Math.max(...xs) } : null;
  return [...byZone.values()]
    .sort((a, b) => (a.number ?? 999) - (b.number ?? 999))
    .map((z) => ({ ...z, rate: stats(z.rates), current: stats(z.currents) }));
}

// ---------------------------------------------------------------- report

const tick = (ok) => (ok === true ? "YES " : ok === false ? "NO  " : "??? ");
const v = (x) => (x && x.value != null ? `${round(x.value)} ${x.unit || ""}`.trim() : null);
const round = (n) => (typeof n === "number" ? Math.round(n * 10) / 10 : n);
const fmtSec = (s) => (s == null ? "—" : s < 3600 ? `${Math.round(s / 60)} min` : `${round(s / 3600)} h`);

function printChecklist(r) {
  const out = [];
  const line = (ok, label, detail) => out.push(`  ${tick(ok)} ${label}${detail ? ` — ${detail}` : ""}`);

  out.push("", "=== 1. Is the API connected? ===");
  line(r.rest.tested ? r.rest.ok : null, "REST v1 (API key)", r.rest.tested ? (r.rest.ok ? "key accepted" : r.rest.error) : "HYDRAWISE_API_KEY not set");
  line(r.gql.tested ? r.gql.ok : null, "GraphQL v2 (login)", r.gql.tested ? (r.gql.ok ? "login accepted" : r.gql.error) : "HYDRAWISE_USERNAME / PASSWORD not set");
  if (r.gql.account) {
    const key = r.gql.account.customer?.apiKey;
    // A refused field also comes back null — don't call that "no key".
    const unsure = !key && r.gql.accountErrors > 0;
    line(key ? true : unsure ? null : false, "API key generated on the Hydrawise account", key ? "yes (value hidden)" : unsure ? "couldn't tell — see errors" : "none — Account Details → Generate API Key");
    line(true, "Account type", `${r.gql.account.userType || "?"}${r.gql.account.contractor ? " · contractor account" : ""}`);
  }
  if (r.controllers?.length) {
    out.push("  Controllers visible:");
    for (const c of r.controllers) out.push(`    - ${c.id}  ${c.name || "(no name)"}  ${c.location?.address || ""}  [${c.owner}]${c.online === false ? "  OFFLINE" : ""}`);
  }
  if (r.picked) line(true, "Test controller", `${r.picked.name} (id ${r.picked.id})${r.pickNote ? ` — ${r.pickNote}` : ""}`);
  if (r.pickProblem) line(false, "Test controller", r.pickProblem);

  const live = r.gql.live;
  const rest = r.rest.schedule;
  out.push("", "=== 2. Zone schedule & live status ===");
  if (live) {
    line(live.online, "Controller online (GraphQL)", `${live.status?.summary || ""} · last contact ${live.lastContactTime?.value || "?"}`);
  }
  if (rest) {
    out.push(`  REST statusschedule: ${rest.relays?.length ?? 0} zones · nextpoll ${rest.nextpoll ?? "?"} s · top-level keys: ${Object.keys(rest).join(", ")}`);
    for (const relay of rest.relays || []) {
      const d = describeRelay(relay);
      out.push(`    Z${String(relay.relay).padStart(2)} ${String(relay.name).padEnd(24)} run ${fmtSec(d.runSec).padStart(7)}  ${d.state === "scheduled" ? `next in ${fmtSec(d.nextInSec)} (${relay.timestr || ""})` : d.state.toUpperCase()}`);
    }
  }
  if (live?.zones) {
    out.push(`  GraphQL zones: ${live.zones.length}`);
    for (const z of live.zones) {
      if (!z) { out.push("    (a zone came back empty — see live.json errors)"); continue; }
      const cur = z.scheduledRuns?.currentRun;
      const next = z.scheduledRuns?.nextRun;
      const last = z.pastRuns?.lastRun;
      out.push(`    ${String(z.number?.label || z.id).padEnd(8)} ${String(z.name).padEnd(24)} ${cur ? `RUNNING, ${fmtSec(cur.remainingTime)} left` : `next ${next?.startTime?.value || "—"} for ${next?.duration ?? "—"} min`} · last ${last?.startTime?.value || "—"} (${last?.duration ?? "—"} min)`);
    }
  }
  const anyRest = Boolean(rest?.relays?.length);
  const anyGql = Boolean(live?.zones?.length);
  line(anyRest || anyGql ? true : null, "Zone run length (scheduled)", [anyRest && "REST `run`", anyGql && "GraphQL nextRun.duration"].filter(Boolean).join(" + "));
  line(anyRest || anyGql ? true : null, "Currently-running status", [anyRest && "REST time==1", anyGql && "GraphQL currentRun + remainingTime"].filter(Boolean).join(" + "));
  line(anyRest || anyGql ? true : null, "Time until next run", [anyRest && "REST `time` (seconds)", anyGql && "GraphQL nextRun.startTime"].filter(Boolean).join(" + "));

  out.push("", "=== 3. Flow meter & water recorded ===");
  const sensors = live?.sensors || [];
  const flowSensors = sensors.filter((s) => s?.model?.sensorType === "FLOW");
  const restFlow = (rest?.sensors || []).filter((s) => s.type === 2);
  if (sensors.length) for (const s of sensors) out.push(`    sensor "${s.name}" · ${s.model?.name || "?"} · ${s.model?.sensorType || "?"} · input ${s.input?.label || "?"} · live flow ${v(s.status?.waterFlow) ?? "—"}`);
  if (rest?.sensors) for (const s of rest.sensors) out.push(`    REST sensor input ${s.input} · ${REST_SENSOR_TYPES[s.type] || `type ${s.type}`} · ${s.relays?.length ?? 0} zones attached`);
  const sawSensors = Boolean(live || rest);
  line(sawSensors ? flowSensors.length > 0 || restFlow.length > 0 : null, "Flow meter installed & configured", flowSensors.map((s) => s.name).join(", ") || (restFlow.length ? "REST lists a flow meter" : "none found"));
  line(live ? flowSensors.some((s) => s.status?.waterFlow) : null, "Live flow reading (GraphQL sensor status)", flowSensors.map((s) => v(s.status?.waterFlow)).filter(Boolean).join(", ") || "empty");

  const zones = r.gql.runSummary;
  const hist = r.gql.history;
  if (hist) {
    const total = hist.reduce((n, z) => n + z.runs, 0);
    const water = hist.reduce((n, z) => n + z.withWater, 0);
    out.push(`  Run history, last ${r.days} days: ${total} zone runs, ${water} with water volume`);
    for (const z of hist) {
      out.push(`    Z${String(z.number ?? "?").padStart(2)} ${String(z.zone).padEnd(24)} runs ${String(z.runs).padStart(3)} · flow ${z.rate ? `${round(z.rate.avg)} ${z.unit}/min (min ${round(z.rate.min)}, max ${round(z.rate.max)})` : "—"} · current ${z.current ? `${round(z.current.avg)} ${z.currentUnit} (min ${round(z.current.min)}, max ${round(z.current.max)})` : "—"} · stops: ${Object.entries(z.stops).map(([k, n]) => `${k}×${n}`).join(", ")}`);
    }
    line(total > 0, "Actual zone runtimes (reported duration per run)", `${total} runs`);
    line(total > 0 ? water > 0 : null, "Water used per run (reportedWaterUsage)", `${water}/${total} runs`);
  }
  if (r.gql.flowTotals) {
    for (const s of r.gql.flowTotals) out.push(`    flow total "${s.name}" over ${r.days} days: ${v(s.flowSummary?.totalWaterVolume) ?? "—"}`);
    line(r.gql.flowTotals.some((s) => s.flowSummary?.totalWaterVolume?.value != null), "Flow-meter total for the period (flowSummary)");
  }
  if (zones) line(zones.some((z) => z?.runSummary?.currentWeek?.totalWaterVolume?.value != null), "Per-zone weekly water volume (runSummary)");

  out.push("", "=== 4. Weather ===");
  const w = r.gql.weather;
  if (w) {
    const obs = w.location?.currentWeatherObservations?.[0];
    const sum = w.observationsSummary;
    const station = (w.weatherStations || []).find((s) => s?.currentObservation);
    const fc = w.location?.forecast?.[0];
    line(Boolean(v(sum?.currentTemperature) || v(obs?.temperature) || v(station?.currentObservation?.temperature)), "Temperature", [v(sum?.currentTemperature) && `now ${v(sum.currentTemperature)}`, v(sum?.maxTemperatureSinceMidnight) && `max today ${v(sum.maxTemperatureSinceMidnight)}`, fc && `forecast high ${v(fc.highTemperature)}`].filter(Boolean).join(" · "));
    line(Boolean(v(obs?.windSpeed) || v(station?.currentObservation?.wind)), "Wind", [v(obs?.windSpeed) && `observed ${v(obs.windSpeed)}`, v(station?.currentObservation?.windGust) && `gust ${v(station.currentObservation.windGust)}`, fc && v(fc.averageWindSpeed) && `forecast avg ${v(fc.averageWindSpeed)}`].filter(Boolean).join(" · "));
    line(Boolean(v(sum?.rainfallLast24Hours) || v(obs?.precipitation)), "Rain (amount)", [v(sum?.rainfallLast24Hours) && `24 h ${v(sum.rainfallLast24Hours)}`, v(sum?.rainfallLast168hours) && `7 d ${v(sum.rainfallLast168hours)}`].filter(Boolean).join(" · "));
    line(Boolean(v(station?.currentObservation?.precipitationLastHour)), "Precipitation rate (last-hour rainfall at a weather station)", v(station?.currentObservation?.precipitationLastHour) || "station sent none");
    if (fc) out.push(`    forecast today: ${fc.conditions || "?"}, POP ${fc.probabilityOfPrecipitation ?? "?"}%, ${v(fc.precipitation) ?? "?"}`);
    if (station) out.push(`    weather station: ${station.location || station.id} (${v(station.distance) ?? "? away"})`);
  } else {
    line(null, "Weather", r.gql.tested ? "weather query failed — see errors" : "needs the GraphQL login");
  }
  if (rest) {
    const weatherKeys = Object.keys(rest).filter((k) => /obs|forecast|temp|rain|wind|weather/i.test(k));
    line(weatherKeys.length > 0, "Weather in REST statusschedule", weatherKeys.join(", ") || "none — REST carries no weather");
  }

  out.push("", "=== 5. Solenoid current (nice-to-have) ===");
  if (hist) {
    const withCur = hist.reduce((n, z) => n + z.withCurrent, 0);
    const total = hist.reduce((n, z) => n + z.runs, 0);
    line(total > 0 ? withCur > 0 : null, "Current per run (reportedCurrent)", `${withCur}/${total} runs`);
  } else {
    line(null, "Current per run (reportedCurrent)", "needs the GraphQL login");
  }
  if (r.gql.charts !== undefined) line(Boolean(r.gql.charts), "Solenoid-load chart (old reporting API)", r.gql.charts ? "returned — see charts.json" : "not available — see errors");

  out.push("", "=== 6. Hydrawise's own alerts ===");
  if (r.gql.alerts) {
    const a = r.gql.alerts;
    out.push(`    ${a.alerts?.length ?? 0} recent alerts, ${a.events?.length ?? 0} recent events`);
    for (const e of (a.alerts || []).slice(0, 8)) out.push(`    ! ${e.eventTime} ${e.severity}: ${e.message}`);
    for (const al of a.customer?.alerts || []) out.push(`    alert rule "${al.name}" · ${al.alertType?.caption || "?"} · value ${al.value ?? "—"} · valve shutoff ${al.valveShutoffActive ? "ON" : "off"}`);
  }

  if (r.errors.length) {
    out.push("", "=== Errors (each query is separate, so one failure doesn't hide the rest) ===");
    for (const e of r.errors) out.push(`  - ${e}`);
  }
  out.push("", `Raw responses (redacted): ${r.outDir}`, "");
  console.log(out.join("\n"));
}

// ---------------------------------------------------------------- main

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`hydrawise-spike: ${err.message}`);
    return 2;
  }
  if (opts.help) {
    console.log("usage: node scripts/hydrawise-spike.mjs [--controller <text>] [--controller-id <id>] [--days N] [--out <dir>]");
    return 0;
  }

  loadRepoEnv();
  const apiKey = process.env.HYDRAWISE_API_KEY?.trim();
  const username = process.env.HYDRAWISE_USERNAME?.trim();
  const password = process.env.HYDRAWISE_PASSWORD;
  if (!apiKey && !(username && password)) {
    console.error("hydrawise-spike: no credentials. Set HYDRAWISE_API_KEY and/or HYDRAWISE_USERNAME + HYDRAWISE_PASSWORD.");
    return 2;
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outDir = opts.out || path.join(os.tmpdir(), `hydrawise-spike-${stamp}`);
  const save = makeSaver(outDir);
  const until = Math.floor(Date.now() / 1000);
  const from = until - opts.days * 86400;

  const r = { days: opts.days, outDir, errors: [], rest: { tested: Boolean(apiKey) }, gql: { tested: Boolean(username && password) } };
  let apiFailure = false;

  // GraphQL first: it can see addresses and contractor customers, so it is
  // the better way to find "the Dundalk controller"; REST then reuses its id.
  if (r.gql.tested) {
    try {
      const graphql = makeGraphql(await graphqlLogin(username, password));
      r.gql.ok = true;

      const account = await graphql("account");
      save("account", account);
      r.errors.push(...account.errors.map((e) => `GraphQL account: ${e}`));
      r.gql.accountErrors = account.errors.length;
      r.gql.account = account.data?.me || null;
      r.controllers = listGraphqlControllers(r.gql.account);
      const pick = pickController(r.controllers, opts);
      r.picked = pick.hit;
      r.pickNote = pick.note;
      r.pickProblem = pick.problem;

      if (r.picked) {
        const id = r.picked.id;
        const run = async (name, vars) => {
          const res = await graphql(name, vars);
          save(name, res);
          r.errors.push(...res.errors.map((e) => `GraphQL ${name}: ${e}`));
          return res;
        };
        // Highest-value first, in case Hydrawise throttles part-way.
        r.gql.live = (await run("live", { id })).data?.controller || null;
        const history = (await run("history", { id, from, until })).data?.controller;
        r.gql.history = history ? summariseRuns(history.reports?.watering) : null;
        r.gql.weather = (await run("weather", { id })).data?.controller || null;
        const totals = (await run("totals", { id, from, until })).data?.controller;
        r.gql.flowTotals = totals?.sensors?.filter(Boolean) || null;
        r.gql.runSummary = totals?.zones || null;
        r.gql.alerts = (await run("alerts", { id })).data?.controller || null;
        r.gql.charts = (await run("charts", { id, from, until })).data?.controller?.reporting || null;
      }
    } catch (err) {
      if (!(err instanceof ApiError)) throw err;
      r.gql.ok = false;
      r.gql.error = err.message;
      r.errors.push(`GraphQL: ${err.message}`);
      apiFailure = true;
    }
  }

  if (r.rest.tested) {
    try {
      const details = await restGet(apiKey, "customerdetails.php", { type: "controllers" });
      save("rest-customerdetails", details);
      r.rest.ok = true;
      const restList = (details.controllers || []).map((c) => ({ ...c, id: c.controller_id, owner: "REST key" }));
      if (!r.controllers?.length) r.controllers = restList;
      const pick = r.picked
        ? pickController(restList, { controllerId: r.picked.id, controller: "" })
        : pickController(restList, opts);
      if (!r.picked) { r.picked = pick.hit; r.pickNote = pick.note; r.pickProblem = pick.problem; }
      if (pick.hit) {
        r.rest.schedule = await restGet(apiKey, "statusschedule.php", { controller_id: pick.hit.controller_id });
        save("rest-statusschedule", r.rest.schedule);
      } else if (r.picked) {
        // GraphQL found it but this key's account can't see it (e.g. a
        // contractor's customer controller) — a finding in its own right.
        r.errors.push(`REST: the API key cannot see controller ${r.picked.id} (${r.picked.name})`);
      }
    } catch (err) {
      if (!(err instanceof ApiError)) throw err;
      r.rest.ok = r.rest.ok ?? false;
      r.rest.error = err.message;
      r.errors.push(`REST: ${err.message}`);
      apiFailure = true;
    }
  }

  printChecklist(r);
  if (apiFailure) return 1;
  return r.picked ? 0 : 2;
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  main().then((code) => { process.exitCode = code; }, (err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
