import { useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { projectsApi, systemBuilderHref, type SiteBuilderStation } from "../lib/api";
import { relativeDay, shortDate } from "../lib/format";
import { Button, Card, CardHeader, EmptyState, Stat } from "../ui/primitives";

/* System Design — the job's design, read here, drawn elsewhere.
 *
 * Patrick chose hand-off over embedding: the System Builder opens as this
 * job's own full-screen route and comes back to this tab. So this tab has
 * two jobs and only two:
 *
 *   1. Say what is saved — the three counts and the plan station by
 *      station — well enough to read on a phone at a property.
 *   2. Open the builder, which is a desktop job.
 *
 * Every number on this screen comes from the server, which ran the saved
 * design through the SAME engine the builder runs. Nothing here is
 * recalculated in the browser; a second implementation of the station
 * rule is how "13 zones" survived for a week.
 */

/* A station's one-line description. Deliberately says "2 valves" only
   when there are two — a station that reads "1 valve" on every line
   teaches you to stop reading the column that matters. */
function stationDetail(s: SiteBuilderStation): string {
  const bits: string[] = [];
  if (s.valves > 1) bits.push(`${s.valves} valves, one station`);
  if (s.headCount) bits.push(`${s.headCount} head${s.headCount === 1 ? "" : "s"}`);
  if (s.gpm) bits.push(`${s.gpm} GPM`);
  // Areas feeding this station, when they aren't just the station's own name
  // (grouped drip beds are the case where they differ and it matters).
  const others = (s.members || []).filter((m) => m !== s.name);
  if (others.length) bits.push(others.join(", "));
  return bits.join(" · ");
}

const FAMILY_LABELS: Record<string, string> = {
  rotor: "Rotors",
  spray: "Sprays",
  drip: "Drip",
  trees: "Trees"
};

export function SystemDesignTab() {
  const { id = "" } = useParams();
  const { data } = useQuery({ queryKey: ["project", id], queryFn: () => projectsApi.get(id), enabled: !!id });
  if (!data) return null;

  const design = data.siteBuilderSummary;
  const stations = design?.stations || [];
  const started = Boolean(design?.areaCount);
  const builderHref = systemBuilderHref(id);
  // A full page navigation, not a router push: the builder is its own
  // document. Leaving the SPA is the point of the hand-off.
  const openBuilder = () => { window.location.href = builderHref; };

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader
          title="System design"
          meta={
            design?.lastSavedAt
              ? `Last saved ${relativeDay(design.lastSavedAt)} · ${shortDate(design.lastSavedAt)}`
              : started
                ? "Drawn, but no save recorded yet"
                : undefined
          }
          actions={
            <Button variant="primary" onClick={openBuilder}>
              {started ? "Open System Builder" : "Start the design"}
            </Button>
          }
        />

        {started ? (
          /* Stations lead: it is what the controller is sized on and what
             the proposal raises a line for. Valves and areas are their own
             figures beside it, never folded into it — Dundalk is 12 · 16 · 19
             and no single number can say that. */
          <div className="px-4 py-4 grid grid-cols-3 gap-4">
            <Stat
              label="Stations"
              value={design?.stationCount ?? 0}
              hint="programmed outputs on the controller"
            />
            <Stat
              label="Valves"
              value={design?.valveCount ?? 0}
              hint="boxes, solenoids and lateral runs"
            />
            <Stat
              label="Areas"
              value={design?.areaCount ?? 0}
              hint="traced landscape areas"
            />
          </div>
        ) : (
          <EmptyState
            title="No design drawn for this job yet"
            body="The System Builder opens full screen with this job attached, and brings you back here when you're done. It works best on a desktop."
            action={<Button variant="primary" onClick={openBuilder}>Start the design</Button>}
          />
        )}
      </Card>

      {/* ── The saved plan ───────────────────────────────────────────
          Station by station, in controller order. This is the half of
          the System Builder that has to work on a phone: standing at a
          property, the question is "what is station 7", and the answer
          should not need a laptop. */}
      {stations.length ? (
        <Card>
          <CardHeader
            title="Saved plan"
            meta={`${stations.length} station${stations.length === 1 ? "" : "s"} in controller order`}
          />
          <ul className="divide-y divide-line">
            {stations.map((s) => {
              const detail = stationDetail(s);
              return (
                <li key={s.station} className="flex items-baseline gap-3 px-4 py-3">
                  <span className="font-display text-[13px] font-bold text-brand-700 tabular-nums shrink-0 w-14">
                    ST {s.station}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block font-semibold text-ink">{s.name}</span>
                    {detail ? <span className="block text-[13px] text-ink-muted">{detail}</span> : null}
                  </span>
                  {FAMILY_LABELS[s.family] ? (
                    <span className="shrink-0 text-[12px] text-ink-muted">{FAMILY_LABELS[s.family]}</span>
                  ) : null}
                </li>
              );
            })}
          </ul>
          <p className="px-4 py-3 border-t border-line text-[13px] text-ink-muted">
            The drawing itself — areas, heads, laterals and the master plan — is in the System Builder.
          </p>
        </Card>
      ) : null}

      {/* The classic builder link, kept while the new route is proven on
          real jobs. Deliberately quiet, and it goes when it is no longer
          the thing you reach for when the new one surprises you. */}
      <p className="text-[13px] text-ink-muted">
        <a
          className="font-semibold text-brand-700 hover:text-brand-800"
          href={`/admin/sitebuilder?project=${encodeURIComponent(id)}`}
        >
          Open the classic builder
        </a>{" "}
        — the same design, at its old address.
      </p>
    </div>
  );
}
