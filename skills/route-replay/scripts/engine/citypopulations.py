"""Modeled geographic lamp mixtures and mean-solar-time occupancy schedules.

The 2016 grayscale light image supplies only source locations/relative strength.
These broad regional priors, fixture spectra, fractions and schedules are not a
measured lamp inventory, land-use map, CCT map, or civil-time-zone database.
"""
from datetime import datetime

import numpy as np

if __package__:
    from .lampspectra import LINEAR_PALETTE, LUMA
else:
    from lampspectra import LINEAR_PALETTE, LUMA

POPULATIONS = ('outdoor', 'building', 'sign', 'persistent')
# Modeled luminous contributions, not counts of installed fixtures. Each row
# follows lampspectra.LAMP_IDS and sums to one. Regional priors below adjust
# these mixes without assigning technology from texture brightness.
_POPULATION_MIXES = np.array([
    [.20, .10, .30, .30, .06, .04],
    [.02, .40, .38, .14, .05, .01],
    [.05, .05, .15, .35, .25, .15],
    [.12, .08, .20, .30, .20, .10],
], dtype=np.float32)

# latitude, longitude, angular width, outdoor/building/sign/persistent shares,
# sodium/warm/neutral technology prior, and building/sign evening curfew hour.
# Overlapping spherical weights deliberately avoid political boundary claims.
REGIONAL_PRIORS = (
    ('North America', 40., -100., 29., (.50, .29, .12, .09), (.25, .43, .32), 23.5, 1.0),
    ('Europe', 50., 15., 24., (.53, .28, .10, .09), (.31, .42, .27), 23.0, 0.0),
    ('East Asia', 34., 120., 25., (.43, .33, .16, .08), (.18, .36, .46), 0.0, 1.5),
    ('South Asia', 20., 78., 23., (.49, .28, .14, .09), (.35, .40, .25), 0.0, 1.0),
    ('Africa', 2., 21., 32., (.57, .25, .09, .09), (.40, .38, .22), 23.0, 0.0),
    ('South America', -18., -59., 30., (.53, .27, .11, .09), (.36, .40, .24), 0.5, 1.0),
    ('Oceania', -27., 140., 25., (.53, .28, .10, .09), (.25, .44, .31), 23.0, 0.0),
)


def unit_points(lon, lat):
    lon, lat = np.broadcast_arrays(lon, lat)
    cp = np.cos(lat.ravel())
    return np.column_stack((cp * np.cos(lon.ravel()), cp * np.sin(lon.ravel()),
                            np.sin(lat.ravel())))


def geographic_noise(points, scale_km, seed):
    """Fixed spherical Cartesian lattice field, continuous at seam and poles."""
    xyz = np.asarray(points) * (6371. / scale_km)
    base = np.floor(xyz).astype(np.int64)
    frac = (xyz - base).astype(np.float32)
    fade = frac * frac * frac * (frac * (frac * 6 - 15) + 10)
    result = np.zeros(len(points), dtype=np.float32)
    for corner in range(8):
        offsets = np.array([corner & 1, (corner >> 1) & 1, (corner >> 2) & 1], dtype=np.int64)
        cell = (base + offsets).astype(np.uint32)
        hashed = (cell[:, 0] * np.uint32(73856093) ^ cell[:, 1] * np.uint32(19349663) ^
                  cell[:, 2] * np.uint32(83492791) ^ np.uint32(seed))
        hashed ^= hashed >> np.uint32(16)
        hashed *= np.uint32(0x7FEB352D)
        hashed ^= hashed >> np.uint32(15)
        hashed *= np.uint32(0x846CA68B)
        hashed ^= hashed >> np.uint32(16)
        value = (hashed >> np.uint32(8)).astype(np.float32) / 16777215.
        result += value * np.prod(np.where(offsets, fade, 1 - fade), axis=1)
    return result


def geographic_fields(lon, lat):
    points = unit_points(lon, lat)
    return geographic_noise(points, 60., 20161017), geographic_noise(points, 18., 20261017)


def regional_populations(lon, lat, fields=None):
    """Smooth geographic priors; texture intensity never assigns lamp types."""
    lon, lat = np.broadcast_arrays(lon, lat)
    shape = lon.shape
    points = unit_points(lon, lat)
    region, district = geographic_fields(lon, lat) if fields is None else fields
    # The unobserved/default prior retains substantial weight everywhere.
    defaults = np.array([.50, .29, .11, .10, .30, .42, .28, 24., 25.])
    total = np.full(len(points), .35)
    values = np.broadcast_to(defaults * .35, (len(points), 9)).copy()
    for _, la, lo, width, shares, color, building, sign in REGIONAL_PRIORS:
        center = unit_points(np.radians(lo), np.radians(la))[0]
        weight = np.exp((points @ center - 1) / (1 - np.cos(np.radians(width))))
        params = np.array([*shares, *color, building if building >= 12 else building + 24,
                           sign if sign >= 12 else sign + 24])
        values += weight[:, None] * params
        total += weight
    values /= total[:, None]
    # Small district variations transfer shares, preserving a unit total.
    variation = np.asarray(district).ravel() - .5
    values[:, 0] += .06 * variation
    values[:, 1] -= .06 * variation
    values[:, 4] += .12 * (np.asarray(region).ravel() - .5)
    values[:, 6] -= .12 * (np.asarray(region).ravel() - .5)
    return {'shares': values[:, :4].astype(np.float32).reshape(shape + (4,)),
            'color_weights': values[:, 4:7].astype(np.float32).reshape(shape + (3,)),
            'building_curfew': values[:, 7].reshape(shape),
            'sign_curfew': values[:, 8].reshape(shape),
            'threshold_factor': 10 ** (.45 * (np.asarray(region).ravel() - .5) +
                                       .25 * variation).reshape(shape)}


def population_mixtures(lon, lat, priors=None, fields=None):
    """Unit-sum lamp-family contributions for four independent populations.

    The broad three-component regional prior is retained for stable existing
    photocell and schedule behavior. Here it modulates the six lamp families.
    An 18 km Earth-fixed field gives coherent district variation; pixels in
    the 2016 source texture do not reveal individual roads or fixtures.
    """
    lon, lat = np.broadcast_arrays(lon, lat)
    if fields is None:
        fields = geographic_fields(lon, lat)
    if priors is None:
        priors = regional_populations(lon, lat, fields)
    prior = np.asarray(priors['color_weights']) / np.array([.30, .42, .28])
    factors = prior[..., [0, 1, 1, 2, 2, 2]]
    district = np.asarray(fields[1]).reshape(lon.shape) - .5
    variation = 1 + .5 * district[..., None] * np.array([.8, .9, .65, -.65, -1., -.4])
    weights = _POPULATION_MIXES * (factors * variation)[..., None, :]
    return (weights / weights.sum(axis=-1, keepdims=True)).astype(np.float32)


def population_colors(lon, lat, priors=None, fields=None):
    """Reference-spectrum RGB, unit luminance for each lighting population."""
    return (population_mixtures(lon, lat, priors, fields) @ LINEAR_PALETTE).astype(np.float32)


def utc_timestamp(when):
    if isinstance(when, datetime):
        if when.tzinfo is None or when.utcoffset() is None:
            raise ValueError('Lamp timestamps must be timezone-aware UTC instants.')
        return when.timestamp()
    value = float(when)
    if not np.isfinite(value):
        raise ValueError('Lamp timestamps must be finite.')
    return value


def local_solar_hour(lon, when):
    """Mean solar time: longitude/15h; deliberately no inferred civil DST."""
    stamp = utc_timestamp(when)
    return np.mod(stamp / 3600 + np.asarray(lon) * (12 / np.pi), 24)


def _sigmoid(value):
    return 1 / (1 + np.exp(np.clip(-value, -60, 60)))


def schedule_fractions(lon, lat, when, priors=None):
    """Outdoor, occupied-building, sign and persistent modeled duty fractions.

    Smooth periodic schedules avoid midnight discontinuities. At the exact
    poles longitude is undefined: the schedule tends to a fixed daily average.
    No airport time zone is extrapolated over neighboring countries or oceans.
    """
    lon, lat = np.broadcast_arrays(lon, lat)
    if priors is None:
        priors = regional_populations(lon, lat)
    hour = local_solar_hour(lon, when)
    def occupied(start, end, width):
        center = (start + end) / 2
        distance = np.abs((hour - center + 12) % 24 - 12)
        return _sigmoid(((end - start) / 2 - distance) / width)
    building = .12 + .88 * occupied(16.5, priors['building_curfew'], .65)
    sign = .08 + .92 * occupied(16., priors['sign_curfew'], .45)
    morning_distance = (hour - 6.5 + 12) % 24 - 12
    morning = .33 * np.exp(-.5 * (morning_distance / .8) ** 2)
    building = np.clip(building + morning, 0, 1)
    midnight_distance = (hour - 3 + 12) % 24 - 12
    outdoor = 1 - .12 * np.exp(-.5 * (midnight_distance / 1.7) ** 2)
    values = np.stack((outdoor, building, sign, np.ones_like(hour)), axis=-1)
    polar_weight = np.cos(lat) ** 2
    average = np.array([.979, .39, .37, 1.])
    return (average + polar_weight[..., None] * (values - average)).astype(np.float32)
