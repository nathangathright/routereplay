"""Bounded clear-air column tables; dated aerosols remain separately integrated.

Only outward rays ending at the atmosphere boundary use this approximation.
Tangents, inward rays, partial paths and non-unit directions retain quadrature.
Tables reproduce the selected midpoint sample budget, rather than changing the
lighting model while optimizing it. No frame/time or random history is stored.
"""
from functools import lru_cache
import numpy as np

HEIGHT_COUNT = 512
ANGLE_COUNT = 512
MIN_COSINE = .02


@lru_cache(maxsize=4)
def column_table(samples, constants):
    earth, outer, hr, hm, *_ = constants
    height_coordinate = np.linspace(0., np.log1p(outer / 4.), HEIGHT_COUNT)
    angle_coordinate = np.linspace(np.sqrt(MIN_COSINE), 1., ANGLE_COUNT)
    height = 4. * np.expm1(height_coordinate)[:, None]
    cosine = angle_coordinate[None, :] ** 2
    radius = 1. + height / earth
    b = radius * cosine
    # Rationalized positive root remains accurate at the atmosphere boundary.
    delta = ((1. + outer / earth) - radius) * ((1. + outer / earth) + radius)
    extent = delta / (np.sqrt(b * b + delta) + b)
    columns = np.zeros((HEIGHT_COUNT, ANGLE_COUNT, 2), np.float64)
    for index in range(samples):
        distance = extent * ((index + .5) / samples)
        h = (np.sqrt(radius * radius + 2 * b * distance + distance * distance) - 1) * earth
        step = extent * earth / samples
        valid = (h >= 0) & (h < outer)
        columns[..., 0] += np.exp(-np.maximum(h, 0) / hr) * step * valid
        columns[..., 1] += np.exp(-np.maximum(h, 0) / hm) * step * valid
    columns.setflags(write=False)
    return columns


def optical_depth_lookup(points, directions, length, *, samples, constants):
    """Return (RGB depth, eligibility mask), with zero outside table coverage."""
    if isinstance(samples, bool) or not isinstance(samples, (int, np.integer)) or samples < 1:
        raise ValueError('Atmospheric table requires a positive integer sample count')
    constants = tuple(float(x) for x in constants)
    if len(constants) != 8 or not np.isfinite(constants).all() or min(constants[:4]) <= 0:
        raise ValueError('Atmospheric table requires eight finite physical constants')
    points, directions, length = np.asarray(points, float), np.asarray(directions, float), np.asarray(length, float)
    shape = np.broadcast_shapes(points.shape[:-1], directions.shape[:-1], length.shape)
    points = np.broadcast_to(points, (*shape, 3)).reshape(-1, 3)
    directions = np.broadcast_to(directions, (*shape, 3)).reshape(-1, 3)
    length = np.broadcast_to(length, shape).ravel()
    earth, outer, *_ = constants
    radius = np.linalg.norm(points, axis=-1)
    height = (radius - 1) * earth
    cosine = np.sum(points * directions, axis=-1) / np.maximum(radius, 1e-30)
    b = radius * cosine
    delta = ((1 + outer / earth) - radius) * ((1 + outer / earth) + radius)
    denominator = np.sqrt(np.maximum(b*b + delta, 0)) + b
    expected = np.divide(delta, denominator, out=np.zeros_like(delta), where=denominator > 0)
    eligible = ((height >= 0) & (height <= outer) & (cosine >= MIN_COSINE) & (cosine <= 1 + 1e-12)
                & (np.abs(np.linalg.norm(directions, axis=-1) - 1) < 1e-10)
                & (length > 0) & np.isfinite(length)
                & (np.abs(length - expected) <= 1e-10))
    result = np.zeros((len(points), 3), np.float64)
    if np.any(eligible):
        table = column_table(int(samples), constants)
        y = np.log1p(height[eligible] / 4) / np.log1p(outer / 4) * (HEIGHT_COUNT - 1)
        x = ((np.sqrt(np.clip(cosine[eligible], MIN_COSINE, 1)) - np.sqrt(MIN_COSINE))
             / (1 - np.sqrt(MIN_COSINE)) * (ANGLE_COUNT - 1))
        yi = np.minimum(y.astype(int), HEIGHT_COUNT - 2)
        xi = np.minimum(x.astype(int), ANGLE_COUNT - 2)
        fy, fx = (y - yi)[:, None], (x - xi)[:, None]
        value = ((1-fy)*((1-fx)*table[yi,xi] + fx*table[yi,xi+1])
                 + fy*((1-fx)*table[yi+1,xi] + fx*table[yi+1,xi+1]))
        result[eligible] = value[:, :1] * np.asarray(constants[4:7]) + value[:, 1:] * constants[7]
    return result.reshape((*shape, 3)), eligible.reshape(shape)
