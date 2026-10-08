# Hydrawise API feasibility spike (Step 1 of controller monitoring)

**Status, 2026-10-08:** desk audit done; **live test against the Dundalk
controller not yet run.** Two blockers, both on Patrick's side:

1. The Claude cloud environment's network policy denies `app.hydrawise.com`
   and `api.hydrawise.com` (proxy `connect_rejected`). Add both under the
   environment's *Network access → Allowed domains*.
2. No Hydrawise credentials exist anywhere in the repo, `.env.example`, or the
   environment. The spike needs `HYDRAWISE_USERNAME` + `HYDRAWISE_PASSWORD`
   (best) and/or `HYDRAWISE_API_KEY`, set as environment secrets — never
   pasted into chat or committed.

Nothing in the monitoring design should be built until the live run below
replaces the "schema says" column with "Dundalk returned".

## Is the API connected?

- **Website:** no. No server code, env var, or script talks to Hydrawise
  today (every `hydrawise` hit in the repo is the `hydrawise_retrofit`
  booking service or page copy).
- **Hydrawise account:** unknown until we can log in. The GraphQL account
  query reads `customer.apiKey`, so the spike answers "has an API key ever
  been generated" directly. To make one: Hydrawise → menu → **Account
  Details → Generate API Key**.

## Two APIs, very different reach

| | REST v1 (`api.hydrawise.com/api/v1`) | GraphQL v2 (`app.hydrawise.com/api/v2/graph`) |
|---|---|---|
| Auth | API key (query string) | OAuth password grant with the Hydrawise app's public client id — how Home Assistant's `pydrawise` does it |
| Documented by Hunter | Yes (REST API PDF v1.6) | Exists ("GraphQL & oAuth 2.0 API"); no public schema — field list below is from `pydrawise`'s bundled `hydrawise.graphql` |
| Rate limit | 30 calls / 5 min per user; 3 start/stop/suspend per 30 s; `nextpoll` in each response | Unpublished. Home Assistant self-limits to 5 calls / 30 min and falls back to REST, after Hydrawise said GraphQL can't take polling load |
| Weather | **None** (top-level keys are time, nextpoll, message, relays, sensors, simRelays, options, stupdate, expanders) | Yes |
| Run history / water used | No | Yes |

**Commercial use:** Hunter's API Terms of Use require Hunter's *prior written
authorization* for commercial use of either API, and say Hunter can change,
charge for, or withdraw them without notice. Monitoring customer controllers
is commercial. Before anything runs in production on Render, email
**support@hydrawise.com** asking for commercial / OAuth access. The spike
itself is a one-off read of Patrick's own account.

## What each requirement maps to

"Schema" = the field exists in the GraphQL schema; it still has to come back
populated for Dundalk (needs a flow meter wired and configured, etc.).

| Requirement | REST v1 | GraphQL v2 | Confidence |
|---|---|---|---|
| Zone scheduled run length | `relays[].run` (seconds) | `zones.scheduledRuns.nextRun.duration` (min) | Documented / schema |
| Currently running | `relays[].time == 1` (then `run` = seconds left) | `scheduledRuns.currentRun` + `remainingTime` (s) | pydrawise logic / schema |
| Time until next run | `relays[].time` (seconds), `timestr` | `scheduledRuns.nextRun.startTime` | Documented / schema |
| Actual runtimes (history) | — | `reports.watering(from, until)` → `runEvent.reportedDuration`, reported start/end | Schema |
| Flow meter present | `sensors[].type == 2` | `sensors.model.sensorType == FLOW` | Documented / schema |
| Live flow reading | — | `sensors.status.waterFlow` | Schema |
| **Water used per run** | — | `runEvent.reportedWaterUsage` | Schema — the key field for broken-head detection (litres ÷ minutes = per-zone L/min, run to run) |
| Flow total for a period | — | `sensors.flowSummary(start, end)`, `zones.runSummary.currentWeek.totalWaterVolume` | Schema |
| Why a run stopped | — | `runEvent.reportedStopReason` (`finishedNormally`, description) | Schema |
| Temperature | — | `observationsSummary.currentTemperature` / `maxTemperatureSinceMidnight`, forecast hi/lo | Schema |
| Wind | — | `location.currentWeatherObservations.windSpeed`, station `wind` / `windGust`, forecast `averageWindSpeed` | Schema |
| Rain | — | `observationsSummary.rainfallLast24Hours` / `rainfallLast168hours` | Schema |
| Precip rate | — | weather station `currentObservation.precipitationLastHour` (closest thing to a rate); forecast POP + amount | Schema |
| **Solenoid current** (nice-to-have) | — | `runEvent.reportedCurrent` — pydrawise's test data shows `{ value: 280, unit: "mA" }` per run | Schema + library fixture |
| Solenoid load chart | — | `reporting.solenoidLoadType` (deprecated, undocumented `option` arg) | Exploratory |
| Hydrawise's own alerts | — | `controller.alerts`, `events`; alert rules incl. high/low flow + valve shutoff (`customer.alerts`) | Schema |

Reading the table: **REST alone can't do the job** — no flow numbers, no
water recording, no weather. Flow / broken-head detection and accurate water
recording both depend on GraphQL run history, and on Dundalk having a flow
meter configured in Hydrawise. Current comes free with the same run history
if Hydrawise populates it.

## The spike script

`scripts/hydrawise-spike.mjs` — read-only (no `setzone.php`, no GraphQL
mutation), REST 2 calls, GraphQL 1 login + up to 7 queries spaced 2 s apart,
highest-value first in case of throttling. Each GraphQL query carries one
risky part, so a failing field can't blank the rest. Finds the controller by
name/address (default "dundalk"), including contractor-customer controllers.
Prints a YES/NO checklist plus per-zone flow (L/min) and current (mA) from the
run history; saves raw responses, redacted, to the OS temp dir.

```sh
NODE_USE_ENV_PROXY=1 node scripts/hydrawise-spike.mjs            # in a Claude cloud session
node scripts/hydrawise-spike.mjs --controller-id 12345 --days 14 # anywhere else
```

Verified offline: all 7 queries validate against `hydrawise.graphql`
(pydrawise 2026.9.1); a full run against a local stub of both APIs, plus
wrong-password, wrong-key, no-credentials, bad-argument and
controller-not-found paths, all exit with the documented codes; the API key
never reaches the saved files.

## Open questions the live run answers

1. Does Patrick's login see Dundalk under his own account or as a contractor
   customer — and can his REST key see it at all?
2. Is a flow meter wired and configured on Dundalk? (Without one, flow fields
   are empty and broken-head detection isn't possible on that site.)
3. Is `reportedWaterUsage` populated per run, and is per-zone L/min steady
   enough run to run to set a "something's broken" threshold?
4. Is `reportedCurrent` populated, and in what unit?
5. Which weather fields actually come back for Dundalk's location / stations?
6. Does GraphQL throttle a one-off burst of ~8 calls?

## Sources

- Hunter, *Hydrawise API Information* — https://www.hunterirrigation.com/support/hydrawise-api-information
- Hunter, *Hydrawise REST API v1.6* (PDF) — https://www.hunterirrigation.com/sites/default/files/2024-10/Hydrawise%20REST%20API%20Ver%201.6_0.pdf
- Hunter, *Hydrawise API Terms of Use* — https://www.hunterirrigation.com/support/hydrawise-api-terms-use
- Hunter, *Hydrawise rate limiting* — https://www.hunterirrigation.com/en-metric/support/hydrawise-rate-limiting-too-many-requests
- pydrawise 2026.9.1 (PyPI) — bundled `hydrawise.graphql` schema, `const.py`, `auth.py`, test fixtures
- Home Assistant hybrid client PR — https://github.com/home-assistant/core/pull/136522
