"""Deterministic unit-Earth shadow geometry for volume quadrature.

The Sun is a 0.53-degree disc. Its visible area uses a locally straight Earth
limb (a good small-disc approximation); extinction still follows the central
solar ray. View intervals are split at the two penumbra edges and centre so
coarse midpoint samples cannot switch an entire long interval on or off.
"""
import numpy as np

SUN_ANGULAR_RADIUS = np.radians(.53 / 2)


def solar_visibility(points, sun):
    """Fraction of the solar disc above the spherical Earth's apparent limb."""
    points = np.asarray(points, np.float64)
    sun = np.asarray(sun, np.float64)
    sun = sun / np.linalg.norm(sun)
    radius = np.linalg.norm(points, axis=-1)
    altitude = np.arcsin(np.clip((points @ sun) / np.maximum(radius, 1e-15), -1, 1))
    depression = np.arccos(1 / np.maximum(radius, 1))
    u = np.clip((altitude + depression) / SUN_ANGULAR_RADIUS, -1, 1)
    fraction = .5 + (np.arcsin(u) + u * np.sqrt(np.maximum(1-u*u, 0))) / np.pi
    return np.where(radius >= 1-1e-12, fraction, 0)


def shadow_boundaries(origins, rays, sun):
    """Forward distances at solar-disc limb crossings, N×6 (missing = inf).

    A crossing at apparent altitude a satisfies
      cos(a)^2 * (|p|^2 - 1) = (p.sun - sin(a))^2,
    on the branch p.sun <= sin(a). Substituting p=o+t*d gives a quadratic.
    Solving both roots handles rays that enter and leave the shadow, including
    tangent views; the linear case handles rays parallel to a cone generator.
    """
    rays = np.asarray(rays, np.float64).reshape(-1, 3)
    origins = np.broadcast_to(np.asarray(origins, np.float64), rays.shape)
    sun = np.asarray(sun, np.float64); sun = sun / np.linalg.norm(sun)
    od = np.sum(origins*rays, axis=-1)
    oo = np.sum(origins*origins, axis=-1)
    dd = np.sum(rays*rays, axis=-1)
    os, ds = origins @ sun, rays @ sun
    result = []
    for angle in (-SUN_ANGULAR_RADIUS, 0., SUN_ANGULAR_RADIUS):
        sine, cosine2 = np.sin(angle), np.cos(angle)**2
        a = cosine2*dd-ds*ds
        b = 2*(cosine2*od-(os-sine)*ds)
        c = cosine2*(oo-1)-(os-sine)**2
        discriminant = b*b-4*a*c
        quadratic = np.abs(a)>1e-12
        root = np.sqrt(np.maximum(discriminant, 0))
        # The q formulation avoids cancellation in the smaller root.
        q = -.5*(b+np.copysign(root, b))
        first = np.divide(q, a, out=np.full_like(a, np.inf), where=quadratic)
        second = np.divide(c, q, out=np.full_like(a, np.inf), where=quadratic & (q!=0))
        repeated = quadratic & (q==0) & (discriminant>=0)
        first[repeated] = second[repeated] = 0
        linear = ~quadratic & (np.abs(b)>1e-12)
        first[linear] = -c[linear]/b[linear]
        for distance in (first, second):
            finite = np.isfinite(distance)
            safe = np.where(finite, distance, 0)
            toward = os+safe*ds
            radius2 = oo+2*safe*od+safe*safe*dd
            valid = finite & (distance>=0) & (radius2>=1-1e-10)
            valid &= toward<=sine+1e-10
            valid &= (quadratic & (discriminant>=0)) | linear
            result.append(np.where(valid, distance, np.inf))
    return np.stack(result, axis=-1)


def split_intervals(intervals, boundaries):
    """Subdivide ordered ray intervals without gaps, overlap or random jitter."""
    for begin, end, hit in intervals:
        active=hit & (end>begin)
        if not np.any(active):
            continue
        if not np.any((boundaries>begin[:,None]) & (boundaries<end[:,None]) & active[:,None]):
            yield begin,end,active
            continue
        clipped = np.minimum(np.maximum(boundaries, begin[:, None]), end[:, None])
        edges = np.sort(np.column_stack((begin, clipped, end)), axis=-1)
        for a, b in zip(edges[:, :-1].T, edges[:, 1:].T):
            active = hit & (end>begin) & (b>a)
            if np.any(active):
                yield a, b, active
