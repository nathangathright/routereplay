#!/usr/bin/env python3
"""Prepare and render an experimental, local, full-scene rear-quarter shot.

This is an explicitly modeled maneuver anchored to a flight instant. It is not
measured flight attitude, and it does not change the normal globe renderer.
"""
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo
from pathlib import Path
import argparse
import hashlib
import json
import math
import os
import shutil
import subprocess
import sys
import numpy as np

SCRIPTS = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPTS / 'engine'))
from data import validate_bundle, bundle_fingerprint
from trip import load_trip
from astronomy import sun_direction
from motion import Motion, basis
from solar_visibility import solar_visibility


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def prepare_terrain(work, assets, bundle, lat, lon, extent=400_000., count=193):
    from terrain_detail import TerrainSampler
    earth = 6_371_000.
    axes = np.asarray(basis(lat, lon))
    yy, xx = np.mgrid[-extent:extent:complex(count), -extent:extent:complex(count)]
    radial = np.sqrt(earth**2 - xx*xx - yy*yy)
    local = np.stack((xx, yy, radial), axis=-1)
    world = local @ axes
    sampler = TerrainSampler(assets / bundle['assets']['terrain']['path'],
                             [assets / item['path'] for item in bundle.get('terrain_tiles', [])],
                             assets / bundle['calibration']['path'] if bundle.get('calibration') else None)
    height = sampler.sample(world)
    local *= (1 + height[..., None] / earth)
    local[..., 2] -= earth
    directions = world / np.linalg.norm(world, axis=-1, keepdims=True)
    longitude = np.arctan2(directions[..., 1], directions[..., 0])
    latitude = np.arcsin(directions[..., 2])
    # Reconcile both axes: neighboring rows can begin on different longitude
    # sheets when an edge column crosses the date line. Image sampling wraps.
    longitude = np.unwrap(np.unwrap(longitude, axis=1), axis=0)
    u = longitude / (2*np.pi) + .5
    uv = np.stack((u, latitude/np.pi + .5), axis=-1)
    faces = []
    for row in range(count-1):
        for col in range(count-1):
            a = row*count+col
            faces.extend(((a, a+1, a+count+1), (a, a+count+1, a+count)))
    np.savez_compressed(work/'terrain.npz', vertices=local.reshape(-1, 3).astype(np.float32),
                        uv=uv.reshape(-1, 2).astype(np.float32), faces=np.asarray(faces, np.int32))


def sun_transmission(altitude_m, sun_cosine):
    """Small physical-scale spherical Rayleigh/Mie direct-light estimate."""
    radius = 6_371_000. + altitude_m
    top = 6_471_000.
    b = radius * sun_cosine
    length = -b + math.sqrt(max(0., b*b + top*top - radius*radius))
    distance = (np.arange(96)+.5) * length/96
    height = np.maximum(np.sqrt(radius*radius+distance*distance+2*b*distance)-6_371_000., 0)/1000
    rayleigh = np.exp(-height/8).sum()*length/96/1000
    mie = np.exp(-height/1.2).sum()*length/96/1000
    return np.exp(-rayleigh*np.array([.0058, .0135, .0331])-mie*.003/.9).tolist()


def parser():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('trip', type=Path)
    p.add_argument('--assets', type=Path, required=True)
    p.add_argument('--at', required=True, help='Physical flight instant, ISO 8601 with UTC offset')
    p.add_argument('--flight', type=int, default=1, help='One-based flight index')
    p.add_argument('--duration', type=float, default=6.)
    p.add_argument('--time-scale', type=float, default=6., help='Physical seconds per video second')
    p.add_argument('--fps', type=int, default=24)
    p.add_argument('--width', type=int, default=360)
    p.add_argument('--samples', type=int, default=8)
    p.add_argument('--bank', type=float, default=15.)
    p.add_argument('--cloud-detail', type=float, default=1., help='Modeled local cloud erosion, 0 to 1')
    p.add_argument('--atmosphere', choices=('volume', 'sky'), default='volume',
                   help='Shared spherical air, or the original sky-only comparison')
    p.add_argument('--cloudscape', choices=('layered', 'local'), default='layered')
    p.add_argument('--cloud-shape', type=float, default=1., help='Modeled cloud-top displacement, 0 to 1')
    p.add_argument('--exposure', type=float, help='Scene exposure in stops (volume: +1.5; sky: 0)')
    p.add_argument('--distance-lengths', type=float, default=3.4)
    p.add_argument('--fov', type=float, default=42.)
    p.add_argument('--device', choices=('cpu', 'metal', 'auto'), default='auto')
    p.add_argument('--threads', type=int, default=6)
    p.add_argument('--workdir', type=Path, default=Path('.flight-chase'))
    p.add_argument('--blender', type=Path)
    p.add_argument('--frames', default='all', help='Comma-separated indices for spot checks, or all')
    p.add_argument('--prepare-only', action='store_true')
    return p


def prepare(args):
    from chase_camera import ChaseConfig, ChaseCamera
    from chase_weather import bake_atlas, configure_runtime
    trip = load_trip(args.trip.resolve())
    if not 1 <= args.flight <= len(trip.legs):
        raise ValueError('Flight index is outside the itinerary')
    if args.exposure is None:
        args.exposure = 1.5 if args.atmosphere == 'volume' else 0.
    values = (args.duration, args.time_scale, args.bank, args.distance_lengths, args.fov,
              args.cloud_detail, args.cloud_shape, args.exposure)
    if not all(math.isfinite(v) for v in values):
        raise ValueError('Shot parameters must be finite')
    if not (1 <= args.duration <= 12 and .1 <= args.time_scale <= 20 and
            12 <= args.fps <= 60 and 180 <= args.width <= 1080 and args.width % 18 == 0 and
            4 <= args.samples <= 256 and 1 <= args.threads <= 32 and
            abs(args.bank) <= 30 and 0 <= args.cloud_detail <= 1 and 0 <= args.cloud_shape <= 1 and
            -4 <= args.exposure <= 4 and 1.5 <= args.distance_lengths <= 8 and 20 <= args.fov <= 70):
        raise ValueError('Shot parameters exceed the bounded prototype limits')
    if args.duration * args.time_scale > 120:
        raise ValueError('The local shot supports at most 120 physical seconds')
    count = round(args.duration * args.fps)
    if args.frames != 'all':
        try:
            selected = [int(value) for value in args.frames.split(',')]
        except ValueError as error:
            raise ValueError('--frames needs comma-separated integer indices or all') from error
        if not selected or any(index < 0 or index >= count for index in selected):
            raise ValueError('Frame index lies outside the prepared shot')
    at = datetime.fromisoformat(args.at)
    if at.utcoffset() is None:
        raise ValueError('--at needs an explicit UTC offset')
    at = at.astimezone(timezone.utc)
    end = at + timedelta(seconds=args.duration*args.time_scale)
    leg = trip.legs[args.flight-1]
    if not leg.depart <= at < end <= leg.arrive:
        raise ValueError('The entire shot must fit within the selected flight')
    weather_at = lambda dt: trip.weather_time(trip.presentation_time(dt, args.flight-1))
    assets = args.assets.resolve()
    month = trip.legs[0].depart.astimezone(ZoneInfo(trip.legs[0].origin.timezone)).month
    bundle = validate_bundle(assets, trip.weather['mode'], weather_at(at), weather_at(end),
                             month, verify_hashes=True)
    motion = Motion(trip)
    progress = (at-leg.depart).total_seconds()/(leg.arrive-leg.depart).total_seconds()
    state = motion.trajectory_state(args.flight-1, progress)
    position = np.asarray(state['position'])
    lat = math.degrees(math.asin(position[2]))
    lon = math.degrees(math.atan2(position[1], position[0]))
    altitude = float(state['altitude_m'])
    if not 1500 <= altitude <= 15_000:
        raise ValueError('Choose an airborne instant between 1,500 and 15,000 m for this prototype')
    if leg.aircraft not in ('a321neo', '777-200er', '787-9', '757-300'):
        raise ValueError('The experimental scene needs a supported dimensional airliner')
    length = {'a321neo':44.51, '777-200er':63.73, '787-9':62.81, '757-300':54.43}[leg.aircraft]
    speed = 230.
    # A local modeled rollout, deliberately independent of noisy measured heading.
    config = ChaseConfig(origin_lat_deg=lat, origin_lon_deg=lon, altitude_m=altitude,
                         heading_deg=motion.route_heading(args.flight-1, progress), speed_mps=speed,
                         duration_s=args.duration*args.time_scale, bank_deg=args.bank,
                         bank_envelope='smooth', aircraft_length_m=length,
                         distance_lengths=args.distance_lengths,
                         heading_lag_s=min(.35, args.duration*args.time_scale))
    camera = ChaseCamera(config)
    frames = []
    axes = np.asarray(basis(lat, lon))
    count = round(args.duration*args.fps)
    for frame in range(count):
        t = frame/args.fps
        sample = camera.sample(t*args.time_scale)
        physical = at + timedelta(seconds=t*args.time_scale)
        sun = sun_direction(physical)
        local_sun = axes @ sun
        aircraft_world = position*6_371_000. + np.asarray(sample['aircraft_position_m']) @ axes
        physical_radius = float(np.linalg.norm(aircraft_world))
        physical_up = aircraft_world / physical_radius
        sample.update(frame=frame, presentation_s=t, physical_utc=physical.isoformat(),
                      sun_enu=local_sun.tolist(), sun_visibility=float(solar_visibility(aircraft_world/6_371_000, sun)),
                      sun_rgb=sun_transmission(physical_radius-6_371_000., float(physical_up@sun)))
        frames.append(sample)
    source_files = [*SCRIPTS.glob('*.py'), *SCRIPTS.joinpath('engine').glob('*.py')]
    settings = {'at':at.isoformat(), 'duration':args.duration, 'time_scale':args.time_scale,
                'fps':args.fps, 'width':args.width, 'samples':args.samples, 'bank':args.bank,
                'distance_lengths':args.distance_lengths, 'fov':args.fov, 'cloud_detail':args.cloud_detail,
                'atmosphere':args.atmosphere, 'cloudscape':args.cloudscape,
                'cloud_shape':args.cloud_shape, 'exposure':args.exposure, 'device':args.device,
                'threads':args.threads, 'flight':args.flight,
                'trip':trip.to_dict(), 'bundle':bundle_fingerprint(bundle),
                'source':{p.relative_to(SCRIPTS).as_posix():digest(p) for p in source_files}}
    key = hashlib.sha256(json.dumps(settings, sort_keys=True).encode()).hexdigest()[:20]
    work = args.workdir.resolve()/key
    work.mkdir(parents=True, exist_ok=True)
    # Blender's reused aircraft materials read this environment even on a hit.
    # Configure it before returning a prepared job, never from ambient inputs.
    os.environ.update(FLIGHT_TRIP=str(args.trip.resolve()), FLIGHT_ASSET_DIR=str(assets),
                      FLIGHT_WORK_DIR=str(work), FLIGHT_COMPUTE='cpu')
    job_path = work/'job.json'
    if job_path.exists():
        job = json.loads(job_path.read_text())
        # Content identity survives moving an identical verified asset bundle.
        job['surface_path'] = str(assets / bundle['assets']['surface']['path'])
        job_path.write_text(json.dumps(job, indent=2, allow_nan=False)+'\n')
        return work, job
    prepare_terrain(work, assets, bundle, lat, lon, extent=600_000., count=257)
    atlas = None
    far_atlas = None
    if trip.weather['mode'] != 'clear':
        # Frozen midpoint weather is explicitly recorded; no claim of a live feed.
        midpoint = at + timedelta(seconds=args.duration*args.time_scale/2)
        runtime = configure_runtime(args.trip.resolve(), assets, work)
        if args.cloudscape == 'layered':
            from chase_cloudscape import bake_atlas as bake_curved, layer_blend
            blend = layer_blend()
            records = []
            for name, extent in (('cloud',blend['near_extent_m']), ('cloud-far',blend['far_extent_m'])):
                metadata = bake_curved(work/name, origin_lat_deg=lat, origin_lon_deg=lon,
                    bounds_xyh_m=[[-extent,extent],[-extent,extent],[120.,16_000.]],
                    shape_zyx=(64,160,160), weather_dt=weather_at(midpoint), physical_dt=midpoint,
                    silhouette_strength=args.cloud_shape, layer_blend_m=blend, write_rgba=False, **runtime)
                records.append(metadata['renderer_record'])
            atlas, far_atlas = records
        else:
            bake_atlas(work/'cloud', origin_lat_deg=lat, origin_lon_deg=lon,
                            origin_altitude_m=0., bounds_enu_m=[[-40_000.,40_000.],[-40_000.,40_000.],[120.,16_000.]],
                            shape_zyx=(64,160,160), weather_dt=weather_at(midpoint), physical_dt=midpoint,
                            write_rgba=False, **runtime)
            atlas = {'npz_path':'cloud.npz', 'bounds_enu_m':[[-40_000.,-40_000.,120.], [40_000.,40_000.,16_000.]]}
    job = {'schema_version':1, 'kind':'experimental-rear-quarter', 'settings':settings,
           'aircraft':leg.aircraft, 'origin':{'lat':lat, 'lon':lon, 'altitude_m':altitude},
           'size':[args.width, round(args.width*16/9/2)*2], 'fps':args.fps,
           'samples':args.samples, 'threads':args.threads, 'device':args.device,
           'horizontal_fov_deg':args.fov, 'surface_path':str(assets/bundle['assets']['surface']['path']),
           'cloud_atlas':atlas, 'far_cloud_atlas':far_atlas,
           'cloud_detail':args.cloud_detail, 'atmosphere':args.atmosphere,
           'exposure_ev':args.exposure, 'frames':frames,
           'limits':['Modeled local rollout at 230 m/s, not an observed maneuver or exact track replay.',
                     'Weather density is frozen at shot midpoint, reconstructed from the dated bundle.',
                     ('Curved near/far weather fields blend across 28–40 km and fade at 450–500 km; vertical silhouettes are modeled.'
                      if args.cloudscape == 'layered' else 'Finite 80 km weather bake fades across its outer 12 percent.'),
                     'Optional stationary 750 m noise erodes nearby cloud density; this is not observed detail.',
                     'Coarse historical seasonal imagery and terrain; simplified dimensional aircraft.',
                     ('Shared spherical RGB air with finite multiple scattering and no ozone; artistic exposure.'
                      if args.atmosphere == 'volume' else 'Nishita background and approximate direct solar attenuation; no aerial perspective.'),
                     'No labels, telemetry, city emission, Moon or globe-to-chase transition in this experiment.']}
    job_path.write_text(json.dumps(job, indent=2, allow_nan=False)+'\n')
    return work, job


def main():
    args = parser().parse_args()
    work, job = prepare(args)
    print(work, flush=True)
    if args.prepare_only:
        return
    blender = args.blender or shutil.which('blender') or '/Applications/Blender.app/Contents/MacOS/Blender'
    if not Path(blender).is_file():
        raise ValueError('Blender was not found; supply --blender')
    with (work/'blender.log').open('w') as log:
        subprocess.run([str(blender), '-b', '--python-exit-code', '1', '--python', str(SCRIPTS/'engine/chase_blender.py'),
                        '--', str(work/'job.json'), '--frames', args.frames], stdout=log,
                       stderr=subprocess.STDOUT, check=True, timeout=14400)
    if args.frames == 'all':
        ffmpeg = shutil.which('ffmpeg')
        if not ffmpeg:
            raise ValueError('ffmpeg is needed to encode the preview')
        subprocess.run([ffmpeg, '-v', 'error', '-y', '-framerate', str(args.fps), '-i', str(work/'frames/%06d.png'),
                        '-c:v', 'libx264', '-crf', '18', '-pix_fmt', 'yuv420p', '-movflags', '+faststart',
                        str(work/'chase.mp4')], check=True, timeout=600)
        from flight_video import verify_video
        verification = verify_video(work/'chase.mp4', len(job['frames']), args.fps)
        (work/'verification.json').write_text(json.dumps(verification, indent=2)+'\n')
        print(work/'chase.mp4', flush=True)


if __name__ == '__main__':
    main()
