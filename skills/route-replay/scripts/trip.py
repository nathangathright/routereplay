"""Validated itineraries and deterministic cinematic timing; standard library only.

The physical clock, weather sampling clock, and editorial timeline are separate.
No network access or fallback to fabricated weather happens in this module.
"""
from __future__ import annotations

from dataclasses import dataclass, replace
from datetime import datetime, timedelta, timezone as datetime_timezone
import hashlib
import json
import math
from pathlib import Path
import re
from typing import Any
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError
from trajectory import Trajectory, parse_trajectory

UTC = datetime_timezone.utc
SUPPORTED_AIRCRAFT = ("a321neo", "777-200er", "787-9", "757-300")
WEATHER_MODES = ("clear", "forecast", "historical", "illustrative_replay")
STYLE_DEFAULTS = {
    "ground_radius": 1300.0,
    "summit_radius": 440.0,
    "relief_exaggeration": 12.0,
    "atmosphere_strength": 1.0,
    "star_strength": 1.0,
    "cloud_strength": 1.0,
    "cloud_phase_g": 0.65,
    "cloud_multiple_scattering": 1.0,
    "cloud_city_glow": 2.0,
    "cloud_lighting": 1.0,
    "cloud_morphology": 1.0,
    "moonlight": 4000.0,
    "atmosphere_multiple_scattering": 1.0,
    "atmosphere_saturation": 1.0,
    "city_light_strength": 1.0,
    "exposure_ev": 0.0,
    "adaptation_s": 0.75,
}
WEATHER_HOLD_MINUTES = 20


class TripError(ValueError):
    """An actionable configuration error, suitable for a CLI error message."""


@dataclass(frozen=True)
class Airport:
    code: str
    name: str
    lat: float
    lon: float
    timezone: str


@dataclass(frozen=True)
class Flight:
    origin: Airport
    destination: Airport
    depart: datetime
    arrive: datetime
    aircraft: str
    trajectory: Trajectory | None = None

    @property
    def departure(self) -> datetime:
        return self.depart

    @property
    def arrival(self) -> datetime:
        return self.arrive

    @property
    def angle(self) -> float:
        if self.trajectory:
            points = (self.origin,) + self.trajectory.points + (self.destination,)
            return sum(angular_distance(a,b) for a,b in zip(points,points[1:]))
        return angular_distance(self.origin, self.destination)


def smootherstep(value: float) -> float:
    value = min(1.0, max(0.0, value))
    return value**3 * (value * (value * 6.0 - 15.0) + 10.0)


def angular_distance(origin: Airport, destination: Airport) -> float:
    """Stable great-circle angle in radians, including across the antimeridian."""
    def vector(airport: Airport) -> tuple[float, float, float]:
        lat, lon = math.radians(airport.lat), math.radians(airport.lon)
        return math.cos(lat) * math.cos(lon), math.cos(lat) * math.sin(lon), math.sin(lat)
    a, b = vector(origin), vector(destination)
    dot = sum(x * y for x, y in zip(a, b))
    cross = (a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2],
             a[0] * b[1] - a[1] * b[0])
    return math.atan2(math.sqrt(sum(x * x for x in cross)), dot)


def _number(value: Any, label: str, *, minimum: float | None = None,
            positive: bool = False) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        raise TripError(f"{label} must be a finite number")
    result = float(value)
    if positive and result <= 0:
        raise TripError(f"{label} must be greater than zero")
    if minimum is not None and result < minimum:
        raise TripError(f"{label} must be at least {minimum:g}")
    return result


def _mapping(value: Any, label: str, allowed: set[str]) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise TripError(f"{label} must be an object")
    unknown = set(value) - allowed
    if unknown:
        raise TripError(f"Unknown {label} field(s): {', '.join(sorted(unknown))}")
    return value


def _required(record: dict[str, Any], key: str, label: str) -> Any:
    if key not in record:
        raise TripError(f"{label}.{key} is required")
    return record[key]


def _instant(value: Any, label: str, airport: Airport | None = None) -> datetime:
    if not isinstance(value, str) or not re.search(r"(?:Z|[+-]\d{2}:\d{2})$", value):
        raise TripError(f"{label} needs an ISO 8601 timestamp with an explicit UTC offset, e.g. 2030-06-01T10:00:00-05:00")
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as exc:
        raise TripError(f"{label} is not a valid ISO 8601 timestamp: {value}") from exc
    if parsed.tzinfo is None or parsed.utcoffset() is None:
        raise TripError(f"{label} must include an explicit UTC offset")
    try:
        utc = parsed.astimezone(UTC)
        if airport is not None:
            local = utc.astimezone(ZoneInfo(airport.timezone))
            if (local.replace(tzinfo=None) != parsed.replace(tzinfo=None)
                    or local.utcoffset() != parsed.utcoffset()):
                raise TripError(f"{label} ({value}) does not match {airport.code}'s {airport.timezone} timezone; check the UTC offset and daylight-saving transition")
    except (OverflowError, ValueError) as exc:
        if isinstance(exc, TripError):
            raise
        raise TripError(f"{label} falls outside the supported calendar range") from exc
    return utc


def _iso(value: datetime) -> str:
    return value.isoformat().replace("+00:00", "Z")


@dataclass(frozen=True)
class Trip:
    title: str
    airports: tuple[Airport, ...]
    legs: tuple[Flight, ...]
    duration_s: float
    fps: int
    departure_hold_s: float
    arrival_hold_s: float
    layover_hold_s: float
    weather: dict[str, Any]
    style: dict[str, float]
    leg_intervals: tuple[tuple[float, float], ...]
    layover_holds_s: tuple[float, ...] | None = None
    telemetry: dict[str, Any] | None = None
    attitude: dict[str, Any] | None = None
    pacing: str = "classic"
    moments: tuple[dict[str, Any], ...] = ()

    @property
    def effective_layover_holds_s(self) -> tuple[float, ...]:
        """Editorial duration per connection; an omitted list uses the scalar default."""
        return (self.layover_holds_s if self.layover_holds_s is not None else
                (self.layover_hold_s,) * (len(self.legs) - 1))

    @property
    def airport_sequence(self) -> tuple[Airport, ...]:
        """Each visited airport occurrence; a return visit is a distinct occurrence."""
        return (self.legs[0].origin,) + tuple(leg.destination for leg in self.legs)

    @property
    def utc_times(self) -> tuple[datetime, ...]:
        return tuple(instant for leg in self.legs for instant in (leg.depart, leg.arrive))

    @property
    def frame_count(self) -> int:
        return max(1, round(self.duration_s * self.fps))

    @property
    def fingerprint(self) -> str:
        encoded = json.dumps(self.to_dict(), sort_keys=True, separators=(",", ":"), allow_nan=False)
        return hashlib.sha256(encoded.encode("utf-8")).hexdigest()

    def _time(self, t: float) -> float:
        return min(self.duration_s, max(0.0, _number(t, "timeline time")))

    def active_leg(self, t: float) -> int:
        t = self._time(t)
        for index in range(len(self.legs) - 1, -1, -1):
            if t >= self.leg_intervals[index][0]:
                return index
        return 0

    def progress(self, index: int, t: float) -> float:
        if not isinstance(index, int) or isinstance(index, bool) or not 0 <= index < len(self.legs):
            raise TripError(f"leg index must be between 0 and {len(self.legs) - 1}")
        start, end = self.leg_intervals[index]
        fraction = (self._time(t) - start) / (end - start)
        if self.pacing == "highlights":
            from pacing import progress
            return progress(self.legs[index], fraction)
        return smootherstep(fraction)

    def presentation_time(self, instant: datetime, flight_index: int) -> float:
        """Map a physical flight instant to presentation time; endpoints own the holds."""
        if isinstance(flight_index, bool) or not isinstance(flight_index, int) or not 0 <= flight_index < len(self.legs):
            raise TripError("flight index is outside this itinerary")
        if not isinstance(instant, datetime) or instant.tzinfo is None or instant.utcoffset() is None:
            raise TripError("moment time must include an explicit UTC offset")
        leg = self.legs[flight_index]
        if not leg.depart <= instant <= leg.arrive:
            raise TripError("moment time must lie within its flight")
        start, end = self.leg_intervals[flight_index]
        fraction = (instant-leg.depart).total_seconds()/(leg.arrive-leg.depart).total_seconds()
        if fraction <= 0: return start
        if fraction >= 1: return end
        if self.pacing == "highlights":
            from pacing import inverse_progress
            position = inverse_progress(leg, fraction)
        else:
            low, high = 0., 1.
            for _ in range(55):
                mid = (low+high)/2
                if smootherstep(mid) < fraction: low = mid
                else: high = mid
            position = (low+high)/2
        return start+(end-start)*position

    def travel_time(self, t: float) -> datetime:
        """Actual itinerary time, with smooth flight/layover motion and fixed end holds."""
        t = self._time(t)
        if t <= self.leg_intervals[0][0]:
            return self.legs[0].depart
        for index, (start, end) in enumerate(self.leg_intervals):
            leg = self.legs[index]
            next_start = self.leg_intervals[index + 1][0] if index + 1 < len(self.legs) else None
            # With a zero-duration editorial connection, the next departure
            # owns the shared boundary; the omitted layover is a deliberate cut.
            if t <= end and (next_start is None or t < next_start):
                return leg.depart + (leg.arrive - leg.depart) * self.progress(index, t)
            if next_start is not None:
                if t < next_start:
                    fraction = smootherstep((t - end) / (next_start - end))
                    return leg.arrive + (self.legs[index + 1].depart - leg.arrive) * fraction
        return self.legs[-1].arrive

    def weather_time(self, t: float) -> datetime:
        """Keep weather moving through end holds; remap dates only for explicit replay."""
        t = self._time(t)
        extension = timedelta(minutes=WEATHER_HOLD_MINUTES)
        first_start, last_end = self.leg_intervals[0][0], self.leg_intervals[-1][1]
        first = self.legs[0].depart - (extension if self.departure_hold_s else timedelta())
        last = self.legs[-1].arrive + (extension if self.arrival_hold_s else timedelta())
        if self.departure_hold_s and t < first_start:
            when = first + extension * smootherstep(t / self.departure_hold_s)
        elif self.arrival_hold_s and t > last_end:
            when = self.legs[-1].arrive + extension * smootherstep((t - last_end) / self.arrival_hold_s)
        else:
            when = self.travel_time(t)
        if self.weather["mode"] == "illustrative_replay":
            sample_start = _instant(self.weather["sample_start"], "weather.sample_start")
            sample_end = _instant(self.weather["sample_end"], "weather.sample_end")
            fraction = (when - first).total_seconds() / (last - first).total_seconds()
            return sample_start + (sample_end - sample_start) * min(1.0, max(0.0, fraction))
        return when

    def to_dict(self) -> dict[str, Any]:
        """Normalized, reloadable configuration; timestamps retain airport-local offsets."""
        return {
            "schema_version": 1, "title": self.title,
            "airports": {a.code: {"name": a.name, "lat": a.lat, "lon": a.lon, "timezone": a.timezone}
                         for a in sorted(self.airports, key=lambda a: a.code)},
            "flights": [{"from": leg.origin.code, "to": leg.destination.code,
                         "departure": leg.depart.astimezone(ZoneInfo(leg.origin.timezone)).isoformat(),
                         "arrival": leg.arrive.astimezone(ZoneInfo(leg.destination.timezone)).isoformat(),
                         "aircraft": leg.aircraft,
                         **({"trajectory": leg.trajectory.to_dict()} if leg.trajectory else {})} for leg in self.legs],
            "video": {"duration_s": self.duration_s, "fps": self.fps,
                      "departure_hold_s": self.departure_hold_s, "arrival_hold_s": self.arrival_hold_s,
                      "layover_hold_s": self.layover_hold_s,
                      **({"pacing": self.pacing} if self.pacing != "classic" else {}),
                      **({"layover_holds_s": list(self.layover_holds_s)}
                         if self.layover_holds_s is not None else {})},
            "weather": dict(self.weather), "style": dict(self.style),
            **({"telemetry": dict(self.telemetry)} if self.telemetry is not None else {}),
            **({"attitude": dict(self.attitude)} if self.attitude is not None else {}),
            **({"moments": [dict(moment) for moment in self.moments]} if self.moments else {}),
        }

    def to_plan(self) -> dict[str, Any]:
        connections = []
        warnings = []
        for index, hold in enumerate(self.effective_layover_holds_s):
            previous, following = self.legs[index:index+2]
            physical_hours = (following.depart - previous.arrive).total_seconds() / 3600
            rate = physical_hours / hold if hold else None
            connections.append({"index": index, "airport": previous.destination.code,
                                "arrival_utc": _iso(previous.arrive), "departure_utc": _iso(following.depart),
                                "physical_hours": physical_hours, "video_duration_s": hold,
                                "video_start_s": self.leg_intervals[index][1],
                                "video_end_s": self.leg_intervals[index+1][0],
                                "physical_hours_per_video_second": rate,
                                "presentation_mode": "animated_layover" if hold else "cut"})
            if rate is not None and rate > 24:
                warnings.append({"code": "rapid_layover_time_compression", "connection_index": index,
                                 "airport": previous.destination.code,
                                 "physical_hours_per_video_second": rate,
                                 "message": (f"Connection {index+1} at {previous.destination.code} advances "
                                             f"{rate:.1f} physical hours per video second on average. "
                                             f"Increase video.layover_holds_s[{index}] to at least "
                                             f"{math.ceil(physical_hours/24*1000)/1000:.3f} seconds, or set it to 0 for an explicit cut.")})
        return {
            "title": self.title, "fingerprint": self.fingerprint,
            "route": [a.code for a in self.airport_sequence],
            "duration_s": self.duration_s, "fps": self.fps, "frame_count": self.frame_count,
            "encoded_duration_s": self.frame_count / self.fps,
            "connections": connections, "warnings": warnings,
            "flights": [{"from": leg.origin.code, "to": leg.destination.code,
                         "departure_utc": _iso(leg.depart), "arrival_utc": _iso(leg.arrive),
                         "aircraft": leg.aircraft, "distance_km": round(leg.angle * 6371.0088, 1),
                         "video_start_s": interval[0], "video_end_s": interval[1],
                         "route_mode": "recorded_waypoints" if leg.trajectory else "illustrative_great_circle",
                         "trajectory_source": leg.trajectory.source if leg.trajectory else None,
                         "trajectory_gaps": leg.trajectory.gaps(leg.depart,leg.arrive) if leg.trajectory else [],
                         **({"pacing": __import__("pacing").plan(leg)} if self.pacing == "highlights" else {})}
                        for leg, interval in zip(self.legs, self.leg_intervals)],
            "weather": {**self.weather, "first_sample_utc": _iso(self.weather_time(0)),
                        "last_sample_utc": _iso(self.weather_time(self.duration_s))},
            "style": dict(self.style),
            "telemetry": dict(self.telemetry or {"enabled": False, "units": "aviation"}),
            "attitude": dict(self.attitude or {"enabled": False}),
            "pacing": self.pacing,
            "moments": __import__("media_moments").plan_moments(self) if self.moments else [],
        }


def trip_from_dict(data: dict[str, Any]) -> Trip:
    data = _mapping(data, "trip", {"schema_version", "title", "airports", "flights", "video", "weather", "style", "telemetry", "attitude", "moments"})
    if isinstance(data.get("schema_version"), bool) or data.get("schema_version") != 1:
        raise TripError("schema_version must be 1")
    title = data.get("title")
    if not isinstance(title, str) or not title.strip():
        raise TripError("title must be a nonempty string")
    records = _required(data, "airports", "trip")
    if not isinstance(records, dict) or not records:
        raise TripError("airports must be a nonempty object keyed by three-letter airport code")
    airports: dict[str, Airport] = {}
    for code, record in records.items():
        if not isinstance(code, str) or re.fullmatch(r"[A-Z]{3}", code) is None:
            raise TripError(f"Invalid airport code {code!r}; use three uppercase letters")
        label = f"airports.{code}"
        record = _mapping(record, label, {"name", "lat", "lon", "timezone"})
        name = record.get("name")
        if not isinstance(name, str) or not name.strip():
            raise TripError(f"{label}.name must be a nonempty string")
        lat, lon = (_number(_required(record, key, label), f"{label}.{key}") for key in ("lat", "lon"))
        if not -90 <= lat <= 90 or not -180 <= lon <= 180:
            raise TripError(f"{label} coordinates must be latitude [-90, 90] and longitude [-180, 180]")
        zone = record.get("timezone")
        try:
            if not isinstance(zone, str):
                raise ValueError("not a string")
            ZoneInfo(zone)
        except (ZoneInfoNotFoundError, ValueError) as exc:
            raise TripError(f"{label}.timezone must name an installed IANA timezone (got {zone!r}); install system tzdata if needed") from exc
        airports[code] = Airport(code, name.strip(), lat, lon, zone)
    flights = data.get("flights")
    if not isinstance(flights, list) or not flights:
        raise TripError("flights must contain at least one flight")
    legs = []
    for index, record in enumerate(flights):
        label = f"flights[{index}]"
        record = _mapping(record, label, {"from", "to", "departure", "arrival", "aircraft", "trajectory"})
        for key in ("from", "to"):
            if not isinstance(record.get(key), str) or record[key] not in airports:
                raise TripError(f"{label}.{key} must reference a code defined in airports")
        origin, destination = airports[record["from"]], airports[record["to"]]
        depart = _instant(_required(record, "departure", label), f"{label}.departure", origin)
        arrive = _instant(_required(record, "arrival", label), f"{label}.arrival", destination)
        if arrive <= depart:
            raise TripError(f"{label}.arrival must be later than departure in UTC")
        if legs and origin.code != legs[-1].destination.code:
            raise TripError(f"{label}.from must be {legs[-1].destination.code} to continue the connected route")
        if legs and depart < legs[-1].arrive:
            raise TripError(f"{label}.departure occurs before the previous flight arrives")
        aircraft = record.get("aircraft")
        if aircraft not in SUPPORTED_AIRCRAFT:
            raise TripError(f"{label}.aircraft must be one of: {', '.join(SUPPORTED_AIRCRAFT)} (got {aircraft!r})")
        try:
            trajectory = parse_trajectory(record["trajectory"], depart, arrive) if "trajectory" in record else None
        except ValueError as exc:
            raise TripError(f"{label}: {exc}") from exc
        if trajectory:
            for airport,point in ((origin,trajectory.points[0]),(destination,trajectory.points[-1])):
                if point.time in (depart,arrive) and angular_distance(airport,point)*6371000 > 20000:
                    raise TripError(f"{label}: endpoint observation is more than 20 km from its airport; correct the flight times or observations")
            chain = (origin,) + trajectory.points + (destination,)
            if any(math.pi-angular_distance(a,b)<1e-7 for a,b in zip(chain,chain[1:])):
                raise TripError(f"{label}: trajectory fallback has antipodal endpoints; add an intermediate observation")
        angle = angular_distance(origin, destination)
        if angle < 1e-7 and not trajectory:
            raise TripError(f"{label} has coincident endpoints; choose distinct airport locations")
        if math.pi - angle < 1e-7 and not trajectory:
            raise TripError(f"{label} has antipodal endpoints, so its great-circle heading is ambiguous; choose a route with an intermediate airport")
        flight = Flight(origin, destination, depart, arrive, aircraft, trajectory)
        if flight.angle < 1e-7:
            raise TripError(f"{label}: trajectory must include travel between distinct locations")
        legs.append(flight)
    video = _mapping(data.get("video", {}), "video", {"duration_s", "fps", "departure_hold_s", "arrival_hold_s", "layover_hold_s", "layover_holds_s", "pacing"})
    pacing = video.get("pacing", "classic")
    if pacing not in ("classic", "highlights"):
        raise TripError("video.pacing must be classic or highlights")
    fps = video.get("fps", 30)
    if isinstance(fps, bool) or not isinstance(fps, int) or fps <= 0:
        raise TripError("video.fps must be a positive integer")
    departure_hold = _number(video.get("departure_hold_s", 1.6), "video.departure_hold_s", minimum=0)
    arrival_hold = _number(video.get("arrival_hold_s", 2.7), "video.arrival_hold_s", minimum=0)
    layover_hold = _number(video.get("layover_hold_s", 1.3), "video.layover_hold_s", minimum=0)
    connection_holds = None
    if "layover_holds_s" in video:
        requested_holds = video["layover_holds_s"]
        if not isinstance(requested_holds, list) or len(requested_holds) != len(legs) - 1:
            raise TripError(f"video.layover_holds_s must be a list with exactly {len(legs)-1} values, one per connection")
        connection_holds = tuple(_number(value, f"video.layover_holds_s[{index}]", minimum=0)
                                 for index, value in enumerate(requested_holds))
    effective_holds = connection_holds if connection_holds is not None else (layover_hold,) * (len(legs)-1)
    holds = departure_hold + arrival_hold + sum(effective_holds)
    duration = _number(video.get("duration_s", holds + 6 * len(legs)), "video.duration_s", positive=True)
    if duration <= holds:
        raise TripError(f"video.duration_s must exceed the combined holds ({holds:g} seconds), leaving time for flight motion")
    weight_sum = sum(math.sqrt(leg.angle) for leg in legs)
    cursor, intervals = departure_hold, []
    for index, leg in enumerate(legs):
        end = cursor + (duration - holds) * math.sqrt(leg.angle) / weight_sum
        if index == len(legs) - 1:
            end = duration - arrival_hold
        if end <= cursor:
            raise TripError("video.duration_s leaves too little representable time for each flight; increase the duration or reduce holds")
        intervals.append((cursor, end))
        if index < len(effective_holds):
            cursor = end + effective_holds[index]
            if effective_holds[index] > 0 and cursor <= end:
                raise TripError(f"video layover {index+1} is too short to represent on this timeline; increase its hold or use 0 for a cut")
    weather = dict(_mapping(data.get("weather", {"mode": "clear"}), "weather", {"mode", "sample_start", "sample_end"}))
    if weather.get("mode") not in WEATHER_MODES:
        raise TripError(f"weather.mode must be one of: {', '.join(WEATHER_MODES)}")
    if weather["mode"] == "illustrative_replay":
        sample_start = _instant(_required(weather, "sample_start", "weather"), "weather.sample_start")
        sample_end = _instant(_required(weather, "sample_end", "weather"), "weather.sample_end")
        if sample_end <= sample_start:
            raise TripError("weather.sample_end must be later than sample_start")
        weather.update(sample_start=_iso(sample_start), sample_end=_iso(sample_end))
    elif "sample_start" in weather or "sample_end" in weather:
        raise TripError("weather.sample_start/sample_end are only valid for illustrative_replay; forecast and historical must use the itinerary dates")
    style = dict(STYLE_DEFAULTS)
    supplied_style = dict(_mapping(data.get("style", {}), "style", set(STYLE_DEFAULTS) | {"cloud_moonlight"}))
    if "cloud_moonlight" in supplied_style:
        legacy = supplied_style.pop("cloud_moonlight")
        if "moonlight" in supplied_style and supplied_style["moonlight"] != legacy:
            raise TripError("Specify one shared style.moonlight value; cloud_moonlight is its legacy alias")
        supplied_style["moonlight"] = legacy
    style.update(supplied_style)
    for key, value in style.items():
        style[key] = _number(value, f"style.{key}", minimum=-10 if key == "exposure_ev" else 0, positive=key.endswith("radius") or key == "adaptation_s")
        if key == "cloud_phase_g" and style[key] > .95:
            raise TripError("style.cloud_phase_g must be in [0, 0.95]")
        if key == "cloud_multiple_scattering" and style[key] > 4:
            raise TripError("style.cloud_multiple_scattering must be in [0, 4]")
        if key == "cloud_lighting" and style[key] > 1:
            raise TripError("style.cloud_lighting must be in [0, 1]")
        if key == "cloud_morphology" and style[key] not in (0,1):
            raise TripError("style.cloud_morphology must be 0 (legacy) or 1 (billows)")
        if key == "moonlight" and style[key] > 20000:
            raise TripError("style.moonlight must be in [0, 20000]")
        if key == "cloud_city_glow" and style[key] > 8:
            raise TripError("style.cloud_city_glow must be in [0, 8]")
        if key == "exposure_ev" and style[key] > 10:
            raise TripError("style.exposure_ev must be in [-10, 10]")
    if style["summit_radius"] > style["ground_radius"]:
        raise TripError("style.summit_radius must not exceed style.ground_radius")
    telemetry = None
    if "telemetry" in data:
        supplied = _mapping(data["telemetry"], "telemetry", {"enabled", "units"})
        telemetry = {"enabled": supplied.get("enabled", False), "units": supplied.get("units", "aviation")}
        if not isinstance(telemetry["enabled"], bool):
            raise TripError("telemetry.enabled must be true or false")
        if telemetry["units"] not in ("aviation", "metric"):
            raise TripError("telemetry.units must be aviation (NM/FT/KT) or metric (KM/M/KM/H)")
    attitude = None
    if "attitude" in data:
        supplied = _mapping(data["attitude"], "attitude", {"enabled", "strength", "max_bank_deg", "max_pitch_deg"})
        attitude = {"enabled": supplied.get("enabled", False)}
        if not isinstance(attitude["enabled"], bool):
            raise TripError("attitude.enabled must be true or false")
        for key, default, maximum in (("strength", 1., 3.), ("max_bank_deg", 25., 45.), ("max_pitch_deg", 12., 25.)):
            value = _number(supplied.get(key, default), "attitude."+key, minimum=0)
            if value > maximum:
                raise TripError(f"attitude.{key} must be at most {maximum:g}")
            attitude[key] = value
    # End-hold sampling must remain a valid datetime as well as the itinerary itself.
    try:
        legs[0].depart - timedelta(minutes=WEATHER_HOLD_MINUTES if departure_hold else 0)
        legs[-1].arrive + timedelta(minutes=WEATHER_HOLD_MINUTES if arrival_hold else 0)
    except OverflowError as exc:
        raise TripError("itinerary is too close to the calendar limit for weather hold samples") from exc
    trip = Trip(title.strip(), tuple(airports.values()), tuple(legs), duration, fps,
                departure_hold, arrival_hold, layover_hold, weather, style, tuple(intervals), connection_holds, telemetry, attitude, pacing)
    if "moments" in data:
        from media_moments import validate_moments
        try:
            trip = replace(trip, moments=validate_moments(data["moments"], trip))
        except ValueError as exc:
            raise TripError(str(exc)) from exc
    return trip


def load_trip(path: str | Path) -> Trip:
    try:
        text = Path(path).read_text(encoding="utf-8")
        data = json.loads(text)
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise TripError(f"Cannot read trip JSON at {path}: {exc}") from exc
    trip = trip_from_dict(data)
    if trip.moments:
        from media_moments import resolve_moments
        trip = resolve_moments(trip, path)
    return trip


if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser(description="Validate an itinerary and print its cinematic render plan.")
    parser.add_argument("trip", type=Path)
    args = parser.parse_args()
    try:
        print(json.dumps(load_trip(args.trip).to_plan(), indent=2))
    except TripError as exc:
        parser.exit(2, f"Trip error: {exc}\n")
