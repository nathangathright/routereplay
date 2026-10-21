"""Linear surface response to directional Sun/Moon irradiance.

Incident Moon RGB already includes phase, horizon, air/cloud extinction and
cinematic gain. Material response applies each once and never changes opacity.
"""
import numpy as np


def ocean_reflection(world, direction, view, tint=(1., .96, .86)):
    """Rough-water GGX/Schlick lobe; direction may be one vector or N vectors.

    Roughness and the inherited 450/255 scale are cinematic, not measured wind
    or water radiometry. Neutral tint lets lunar incident RGB carry its color.
    """
    direction = np.broadcast_to(np.asarray(direction), np.shape(world))
    nl = np.clip(np.sum(world*direction, axis=-1), 0, 1)
    nv = np.clip(np.sum(world*view, axis=-1), 0, 1)
    half = direction+view
    half = half/np.maximum(np.linalg.norm(half, axis=-1)[:, None], 1e-7)
    nh = np.clip(np.sum(world*half, axis=-1), 0, 1)
    lh = np.clip(np.sum(half*direction, axis=-1), 0, 1)
    alpha = .30**2
    distribution = alpha*alpha/(np.pi*(nh*nh*(alpha*alpha-1)+1)**2)
    fresnel = .02+.98*(1-lh)**5
    def smith(cosine):
        return 2*cosine/(cosine+np.sqrt(alpha*alpha+(1-alpha*alpha)*cosine*cosine)+1e-7)
    spec = fresnel*distribution*smith(nl)*smith(nv)/(4*nl*nv+1e-6)
    return (spec*nl*(450/255))[:, None]*np.asarray(tint)


def lunar_surface_radiance(world, normals, view, albedo, land, direction, incident):
    """Lambert terrain and view-dependent ocean glint from shared Moon flux."""
    cosine = np.maximum(np.sum(normals*direction, axis=-1), 0)
    diffuse = .965*albedo*cosine[:, None]
    specular = ocean_reflection(world, direction, view, tint=(1., 1., 1.))*(1-land)
    return (diffuse+specular)*incident
