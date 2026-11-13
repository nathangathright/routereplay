import { AIRCRAFT_TYPES } from '../../shared/scene/aircraft';
import type { NormalizedSceneV1 } from '../../shared/scene/types';

function formatLocal(utc: string, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat(undefined, {
      timeZone,
      weekday: 'short',
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      timeZoneName: 'short',
    }).format(new Date(utc));
  } catch {
    return utc;
  }
}

function formatDuration(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h > 0 ? `${h} h ${m.toString().padStart(2, '0')} m` : `${m} m`;
}

const km = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 });

const MODE_NAMES: Record<string, string> = { train: 'Train', bus: 'Bus', car: 'Car', ferry: 'Ferry' };

/** "3 flights", or "5 legs: 3 flights, 2 by land and sea" once the journey leaves the air. */
function legCount(scene: NormalizedSceneV1): string {
  const n = scene.legs.length;
  const surface = scene.legs.filter((l) => l.mode !== undefined).length;
  const flights = n - surface;
  const plural = (k: number, one: string, many: string) => `${k} ${k === 1 ? one : many}`;
  if (surface === 0) return plural(n, 'flight', 'flights');
  if (flights === 0) return plural(n, 'leg', 'legs');
  return `${plural(n, 'leg', 'legs')}: ${plural(flights, 'flight', 'flights')}, ${surface} by land and sea`;
}

/** Text summary of the journey: always available, and the fallback when 3D cannot run. */
export function RouteSummary({ scene, currentLeg }: { scene: NormalizedSceneV1; currentLeg?: number }) {
  const total = scene.legs.reduce((s, l) => s + l.distanceKm, 0);
  return (
    <section className="panel" aria-labelledby="route-summary-title">
      <div className="row spread">
        <h2 id="route-summary-title">Route</h2>
        <span className="note">
          {legCount(scene)} · {km.format(total)} km great-circle
        </span>
      </div>
      <ol className="legs">
        {scene.legs.map((leg, i) => {
          const from = scene.airports[leg.from]!;
          const to = scene.airports[leg.to]!;
          const next = scene.legs[i + 1];
          const connection = next ? Date.parse(next.departureUtc) - Date.parse(leg.arrivalUtc) : null;
          // Records from before aircraft types (shown here when they can't be played) have neither.
          const craft = leg.mode !== undefined ? MODE_NAMES[leg.mode] : leg.aircraft && AIRCRAFT_TYPES[leg.aircraft]?.name;
          return (
            <li key={leg.id} className={`leg${i === currentLeg ? ' current' : ''}`} aria-current={i === currentLeg ? 'step' : undefined}>
              <span className="leg-codes" aria-label={`${from.name} to ${to.name}`}>
                {leg.from} → {leg.to}
              </span>
              <span className="leg-detail">
                <strong>{from.city || from.name}</strong> to <strong>{to.city || to.name}</strong> · {km.format(leg.distanceKm)} km ·{' '}
                {formatDuration(Date.parse(leg.arrivalUtc) - Date.parse(leg.departureUtc))}
                {craft && ` · ${craft}`}
                <br />
                Departs {formatLocal(leg.departureUtc, from.timeZone)} · Arrives {formatLocal(leg.arrivalUtc, to.timeZone)}
                {connection !== null && (
                  <>
                    <br />
                    Connection at {leg.to}: {formatDuration(connection)}
                  </>
                )}
              </span>
            </li>
          );
        })}
      </ol>
      {scene.legs.some((l) => l.path) && (
        // Looked-up routes are produced from OpenStreetMap, whose licence asks for this credit where they are shown.
        <p className="note">
          Ground routes: map data ©{' '}
          <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">
            OpenStreetMap contributors
          </a>
        </p>
      )}
    </section>
  );
}
