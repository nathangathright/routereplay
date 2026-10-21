"""Asset-free flight telemetry on the itinerary's physical clock.

Distances are spherical horizontal route lengths (Earth radius 6,371 km), not
3D air distance. Supplied waypoints are treated as observations, without
independently verifying their source. Short intervals interpolate position and
MSL altitude; speed is distance divided by physical timestamp interval. Long
gaps retain only an explicitly estimated route distance, never a plausible-
looking speed or altitude. An untracked flight uses its physical leg-average
speed and a nominal 11 km sine altitude, both explicitly illustrative estimates.
The latter assumes a sea-level baseline and is not a terrain clearance value.

The bounded identity cache avoids rehashing/scanning every waypoint per frame.
Trips and their immutable flight/trajectory records must not be replaced in
place while sampling. No renderer, NumPy, asset files or weather are imported.
"""
from bisect import bisect_right
from collections import OrderedDict
from dataclasses import dataclass
import math

from trip import angular_distance

EARTH_RADIUS_M = 6_371_000.
_CACHE = OrderedDict()
_CACHE_SIZE = 8


@dataclass(frozen=True)
class _Route:
    times: tuple
    altitudes: tuple
    observed: tuple
    cumulative: tuple
    gaps: tuple
    estimated_prefix: tuple
    illustrative: bool


def _prepare(trip):
    key = id(trip)
    cached = _CACHE.get(key)
    if cached is not None and cached[0] is trip:
        _CACHE.move_to_end(key)
        return cached[1]
    routes = []
    totals = [0.]
    estimated = [False]
    for leg in trip.legs:
        duration = (leg.arrive-leg.depart).total_seconds()
        track = leg.trajectory
        if track is None:
            points = [leg.origin, leg.destination]
            times = [0., duration]
            altitudes = [None, None]
            observed = [False, False]
        else:
            points = list(track.points)
            times = [(point.time-leg.depart).total_seconds() for point in points]
            altitudes = [point.altitude_m for point in points]
            observed = [True]*len(points)
            # Match Motion's geographic terminal anchors, but never copy its
            # zero-altitude placeholders into physical telemetry.
            if times[0] > 0:
                points.insert(0, leg.origin);times.insert(0, 0.)
                altitudes.insert(0, None);observed.insert(0, False)
            if times[-1] < duration:
                points.append(leg.destination);times.append(duration)
                altitudes.append(None);observed.append(False)
        cumulative = [0.]
        gaps = []
        estimated_prefix = [False]
        for index, (a, b) in enumerate(zip(points, points[1:])):
            cumulative.append(cumulative[-1]+EARTH_RADIUS_M*angular_distance(a,b))
            gap = (track is None or not (observed[index] and observed[index+1])
                   or times[index+1]-times[index] > track.max_gap_s)
            gaps.append(gap)
            estimated_prefix.append(estimated_prefix[-1] or gap)
        routes.append(_Route(tuple(times),tuple(altitudes),tuple(observed),
                             tuple(cumulative),tuple(gaps),tuple(estimated_prefix),track is None))
        totals.append(totals[-1]+cumulative[-1])
        estimated.append(estimated[-1] or estimated_prefix[-1])
    prepared = (tuple(routes),tuple(totals),tuple(estimated))
    _CACHE[key] = (trip,prepared)
    _CACHE.move_to_end(key)
    while len(_CACHE) > _CACHE_SIZE:
        _CACHE.popitem(last=False)
    return prepared


def sample(trip, t):
    """Return a JSON-ready telemetry dict for cinematic time ``t`` in seconds.

    ``physical_time`` is UTC ISO8601, ``distance_m`` is cumulative over all
    flights, ``altitude_m`` is MSL (or the declared illustrative estimate), and
    ``ground_speed_mps`` is horizontal speed. Unknown numbers are ``None``.
    Holds have zero speed; altitude is available only from an observed terminal
    (the previous arrival during a layover). Holds do not accumulate distance.

    ``mode``: observed, interpolated, gap, illustrative, or hold.
    ``distance_basis``: derived (zero at start), interpolated, or estimated.
    ``altitude_basis``: observed, interpolated, illustrative, or unavailable.
    ``speed_basis``: derived, estimated, or unavailable. At an exact waypoint,
    speed averages available adjacent short segments by their physical duration;
    intervals exceeding max_gap_s never contribute. Times outside the video are
    clamped exactly as in Trip. A zero-duration connection belongs to the next
    flight, matching Trip.travel_time and Motion.
    """
    t = trip._time(t)
    routes, totals, estimates = _prepare(trip)
    when = trip.travel_time(t)
    index = trip.active_leg(t)
    start, end = trip.leg_intervals[index]
    phase = 'flight'
    if t < trip.leg_intervals[0][0]:
        phase = 'departure_hold'
    elif t >= trip.leg_intervals[-1][1]:
        phase = 'arrival_hold'
    elif t >= end:
        phase = 'layover'
    route = routes[index]
    result = {'leg_index':index,'phase':phase,
              'physical_time':when.isoformat().replace('+00:00','Z'),
              'mode':'hold','distance_m':0.,'altitude_m':None,'ground_speed_mps':0.,
              'distance_basis':'derived','altitude_basis':'unavailable','speed_basis':'derived',
              'trajectory_source':trip.legs[index].trajectory.source if trip.legs[index].trajectory else None}
    if phase != 'flight':
        terminal = 0 if phase == 'departure_hold' else -1
        completed = 0 if phase == 'departure_hold' else index+1
        result['distance_m'] = totals[completed]
        if completed:
            result['distance_basis'] = 'estimated' if estimates[completed] else 'interpolated'
        if route.observed[terminal]:
            result.update(altitude_m=route.altitudes[terminal],altitude_basis='observed')
        return result

    seconds = min(route.times[-1],max(0.,(when-trip.legs[index].depart).total_seconds()))
    segment = min(len(route.times)-2,max(0,bisect_right(route.times,seconds)-1))
    interval = route.times[segment+1]-route.times[segment]
    fraction = min(1.,max(0.,(seconds-route.times[segment])/interval))
    length = route.cumulative[segment+1]-route.cumulative[segment]
    distance = totals[index]+route.cumulative[segment]+length*fraction
    estimated = (estimates[index] or route.estimated_prefix[segment]
                 or (route.gaps[segment] and fraction > 0))
    result.update(distance_m=distance,distance_basis='derived' if distance == 0 else
                  'estimated' if estimated else 'interpolated')
    if route.illustrative:
        progress = seconds/route.times[-1]
        altitude = 11000*math.sin(math.pi*progress) if 0 < progress < 1 else None
        result.update(mode='illustrative',altitude_m=altitude,
                      altitude_basis='illustrative' if altitude is not None else 'unavailable',
                      ground_speed_mps=route.cumulative[-1]/route.times[-1],
                      speed_basis='estimated')
        return result

    node = next((j for j in (segment,segment+1)
                 if route.observed[j] and abs(seconds-route.times[j]) <= 1e-6),None)
    if node is not None:
        good = [j for j in (node-1,node) if 0 <= j < len(route.gaps) and not route.gaps[j]]
        speed = (sum(route.cumulative[j+1]-route.cumulative[j] for j in good)
                 /sum(route.times[j+1]-route.times[j] for j in good)) if good else None
        result.update(mode='observed',altitude_m=route.altitudes[node],altitude_basis='observed',
                      ground_speed_mps=speed,speed_basis='derived' if good else 'unavailable')
    elif route.gaps[segment]:
        result.update(mode='gap',ground_speed_mps=None,speed_basis='unavailable')
    else:
        altitude = route.altitudes[segment]*(1-fraction)+route.altitudes[segment+1]*fraction
        result.update(mode='interpolated',altitude_m=altitude,altitude_basis='interpolated',
                      ground_speed_mps=length/interval,speed_basis='derived')
    return result
