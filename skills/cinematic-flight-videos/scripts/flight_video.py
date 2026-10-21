#!/usr/bin/env python3
"""Plan, preview and render reproducible cinematic flight videos from trip JSON."""
from __future__ import annotations
import argparse
from concurrent.futures import ProcessPoolExecutor
from contextlib import contextmanager
from datetime import datetime, timezone
import errno
import hashlib
import importlib.metadata
import json
import math
import os
import platform
from pathlib import Path
import shutil
import subprocess
import sys
import time
from zoneinfo import ZoneInfo

SCRIPTS = Path(__file__).resolve().parent
ENGINE = SCRIPTS / 'engine'
sys.path.insert(0, str(ENGINE))
from trip import load_trip, trip_from_dict


def write_json(path, data):
    path = Path(path)
    temporary = path.with_name(path.name+'.tmp')
    temporary.write_text(json.dumps(data, indent=2, allow_nan=False)+'\n')
    temporary.replace(path)


def executable(name):
    found = shutil.which(name)
    if not found and name == 'blender':
        mac = Path('/Applications/Blender.app/Contents/MacOS/Blender')
        if mac.is_file():
            found = str(mac)
    return found


def doctor():
    packages = {}
    for name in ('numpy', 'scipy', 'Pillow', 'pyerfa', 'tzdata'):
        try:
            packages[name] = importlib.metadata.version(name)
        except importlib.metadata.PackageNotFoundError:
            packages[name] = None
    try:
        ZoneInfo('UTC')
        timezone_data = 'available (system database or tzdata package)'
    except Exception:
        timezone_data = 'missing; install tzdata'
    return {'python': sys.version.split()[0], 'platform':platform.platform(), 'packages': packages,
            'tools': {name: executable(name) for name in ('blender', 'ffmpeg', 'ffprobe')},
            'missing_packages': [name for name, version in packages.items() if not version and name != 'tzdata'],
            'timezone_data': timezone_data,
            'note': 'Blender is required for Cycles aircraft; diagram mode is an explicit layout preview.'}


def cache_key(trip, bundle, aircraft_mode, environment, quality="delivery", transport="layered", *, media_identity_record=None):
    """Content, dates, renderer, font and tool versions invalidate cached pixels."""
    sources = hashlib.sha256()
    for path in sorted(SCRIPTS.rglob('*.py')):
        sources.update(path.relative_to(SCRIPTS).as_posix().encode())
        sources.update(path.read_bytes())
    from engine.fonts import flap_font
    font = flap_font(300)
    font_path = getattr(font, 'path', None)
    font_id = (hashlib.sha256(Path(font_path).read_bytes()).hexdigest()
               if isinstance(font_path, (str, bytes, os.PathLike)) and Path(font_path).is_file()
               else 'Pillow-default-'+str(environment['packages']['Pillow']))
    # Retrieval timestamps and source-directory locations are not pixel inputs.
    stable_bundle = {key: value for key, value in bundle.items() if key != 'created_at'}
    stable_environment = dict(environment)
    for field in ('cycles_device','compute_device'):
        if field in stable_environment:
            stable_environment[field] = {name:value for name,value in stable_environment[field].items()
                                         if name != 'fallback_reason'}
    record = {'trip': trip.fingerprint, 'bundle': stable_bundle,
              'source_sha256': sources.hexdigest(), 'aircraft': aircraft_mode,
              'environment': stable_environment, 'font_sha256': font_id, 'quality':quality, 'transport':transport}
    if trip.telemetry and trip.telemetry['enabled']:
        from engine.fonts import telemetry_font
        font = telemetry_font(54, override=os.environ.get('FLIGHT_TELEMETRY_FONT'))
        record['telemetry_font_sha256'] = hashlib.sha256(Path(font.path).read_bytes()).hexdigest()
    if trip.moments:
        from media_moments import media_identity
        record['media'] = media_identity(trip) if media_identity_record is None else media_identity_record
    return hashlib.sha256(json.dumps(record, sort_keys=True).encode()).hexdigest()


@contextmanager
def render_cache_lock(work):
    """Hold one OS-owned advisory lock without leaving stale PID ownership."""
    work = Path(work)
    work.parent.mkdir(parents=True, exist_ok=True)
    # Keep a stable inode outside the cache; never unlink an advisory lock file.
    with (work.parent/('.'+work.name+'.lock')).open('a+b') as handle:
        if os.name == 'nt':
            import msvcrt
            if handle.tell() == 0:
                handle.write(b'\0'); handle.flush()
            handle.seek(0)
            acquire = lambda: msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
        else:
            import fcntl
            acquire = lambda: fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        try:
            acquire()
        except OSError as exc:
            if exc.errno in (errno.EACCES, errno.EAGAIN, errno.EDEADLK):
                raise RuntimeError(f'Render cache is already in use: {work}. '
                                   'Wait for that run to finish or choose another --workdir.') from exc
            raise
        yield  # Closing the handle also releases the lock after errors or exit.


@contextmanager
def configure(args, trip, bundle):
    environment = doctor()
    required = [name for name in environment['missing_packages'] if name != 'tzdata']
    if required:
        raise ValueError('Install scripts/requirements.txt; missing: '+', '.join(required))
    if args.aircraft == 'cycles':
        blender = environment['tools']['blender']
        if not blender:
            raise ValueError('Blender is required. Install Blender or choose --aircraft diagram for a layout proof.')
        environment['blender_version'] = subprocess.check_output([blender, '--version'], text=True).splitlines()[0]
        from acceleration import cycles_device
        environment['cycles_device'] = cycles_device(blender, getattr(args, 'cycles_device', 'cpu'),
                                                     timeout=getattr(args, 'blender_probe_timeout', 300.))
        environment['blender_threads'] = getattr(args, 'blender_threads', 2)
    from acceleration import compute_device
    quality = getattr(args,"quality","delivery")
    transport = getattr(args, 'transport', 'layered')
    requested_options = {name:getattr(args, name, 'reference')
                         for name in ('cloud_view','atmosphere_view','cloud_source')}
    for name, value in requested_options.items():
        if value not in ('reference','batched'):
            raise ValueError(name.replace('_',' ').capitalize()+' must be reference or batched.')
    environment['compute_device'] = compute_device(getattr(args, 'compute', 'cpu'),
        atmosphere_view=requested_options['atmosphere_view'] if transport == 'layered' else 'reference')
    environment['atmosphere_method'] = getattr(args, 'atmosphere_method', 'integrate')
    environment.update(requested_options)
    if environment['atmosphere_method'] not in ('integrate', 'lookup'):
        raise ValueError('Atmosphere method must be integrate or lookup.')
    option_fallbacks = {}
    for name, requested in requested_options.items():
        if requested != 'batched':
            continue
        reason = None
        if environment['compute_device']['backend'] != 'metal':
            reason = 'Batched '+name.replace('_',' ')+' requires Metal compute.'
        elif transport != 'layered':
            reason = 'Batched '+name.replace('_',' ')+' requires layered transport.'
        elif name.startswith('cloud_') and trip.style.get('cloud_lighting', 1.) != 1.:
            reason = 'Batched '+name.replace('_',' ')+' requires cloud_lighting=1.'
        elif name.startswith('cloud_') and trip.weather['mode'] == 'clear':
            reason = 'Clear weather does not render clouds.'
        if reason:
            option_fallbacks[name] = reason
            environment[name] = 'reference'
    reconstruction = getattr(args, 'volume_reconstruction', 'reference')
    if reconstruction not in ('reference', 'adaptive', 'full'):
        raise ValueError('Volume reconstruction must be reference, adaptive or full.')
    requested_options['volume_reconstruction'] = reconstruction
    if reconstruction != 'reference' and transport != 'layered':
        option_fallbacks['volume_reconstruction'] = 'Spatial volume reconstruction requires layered transport.'
        reconstruction = 'reference'
    environment['volume_reconstruction'] = reconstruction
    media_record = None
    if trip.moments:
        from media_moments import media_identity
        media_record = media_identity(trip)
    key = cache_key(trip, bundle, args.aircraft, environment,quality,transport,
                    media_identity_record=media_record)
    work_root = Path(args.workdir).expanduser().resolve()
    work = work_root / key[:20]
    from scene_cache import identity as scene_identity
    scene_record = scene_identity(trip, bundle, args.aircraft, environment, quality, transport)
    scene_work = work_root / 'scenes' / scene_record['key']
    estimate_only=getattr(args,'estimate_only',False)
    if estimate_only and (not (work/'provenance.json').is_file() or not (work/'trip.json').is_file()):
        raise ValueError('No matching render cache exists; run budget without --estimate-only to measure this configuration.')
    with render_cache_lock(work):
        work.mkdir(parents=True, exist_ok=True)
        snapshot = work/'trip.json'
        if not estimate_only:
            write_json(snapshot, trip.to_dict())
        from scene_cache import configure_cache
        scene_status = configure_cache(scene_work, scene_record, trip.fps,
                                       mode=getattr(args, 'scene_cache', 'on'), estimate_only=estimate_only)
        os.environ.update(FLIGHT_TRIP=str(snapshot), FLIGHT_ASSET_DIR=str(Path(args.assets).expanduser().resolve()),
                          FLIGHT_WORK_DIR=str(work), FLIGHT_AIRCRAFT_MODE=args.aircraft, FLIGHT_TRANSPORT=transport,
                          FLIGHT_COMPUTE=environment['compute_device']['backend'],
                          FLIGHT_AIRCRAFT_DIR=str(work/'aircraft'),FLIGHT_QUALITY=quality,
                          FLIGHT_ATMOSPHERE_METHOD=environment['atmosphere_method'],
                          FLIGHT_CLOUD_VIEW=environment['cloud_view'],
                          FLIGHT_ATMOSPHERE_VIEW=environment['atmosphere_view'],
                          FLIGHT_CLOUD_SOURCE=environment['cloud_source'],
                          FLIGHT_VOLUME_RECONSTRUCTION=environment['volume_reconstruction'])
        provenance = {'schema_version': 1, 'cache_key': key, 'plan': trip.to_plan(),
                      'bundle': bundle, 'environment': environment, 'aircraft_mode': args.aircraft,
                      'requested_render_options': requested_options,
                      **({'render_option_fallbacks': option_fallbacks} if option_fallbacks else {}),
                      **({'media_identity': media_record} if media_record else {}),
                      'quality': __import__('quality').get_quality(quality).to_dict(), 'transport':transport,
                      'scene_cache': scene_status,
                      'created_utc': datetime.now(timezone.utc).isoformat(),
                      'limitations': ['Routes use recorded waypoints only where supplied; interpolation and gaps are listed per leg in plan.',
                                      'Historical seasonal Earth textures; CIE reference-spectrum lamp colors with modeled regional and population mixtures and activation. These are not measured city CCT or absolute radiance.',
                                      'Cloud detail, regional lamp priors, exposure and aircraft apparent size are modeled cinematic choices.',
                                      'Scene-relative linear HDR is not calibrated radiance; local terrain is a coarse global-grid prior.']}
        if args.aircraft == 'diagram':
            provenance['limitations'].append('Aircraft is a 2D layout diagram, not a Cycles render.')
        if trip.attitude and trip.attitude['enabled']:
            provenance['limitations'].append('Bank and pitch are modeled from physical-time route curvature and climb, not recorded aircraft attitude. Holds and missing data suppress motion; the 2D diagram remains level.')
        if trip.moments:
            provenance['limitations'].append('Local photo/video moments are anchored to flight UTC. Their duration is presentation time; clips are silent and contained without cropping.')
        if trip.telemetry and trip.telemetry['enabled']:
            provenance['limitations'].append('Telemetry shows cumulative horizontal distance, MSL altitude and ground speed on the physical flight clock. Speed is derived from adjacent timestamps. ≈ marks reconstructed distance across gaps or illustrative flights; gap altitude/speed are unavailable. Holds use zero speed and only exact observed terminal altitudes. Untracked flights use estimated leg-average speed and a nominal 11 km sine altitude, not measured flight performance.')
            from telemetry import sample
            if not estimate_only:
                write_json(work/'telemetry.json', [dict(frame=tick, presentation_s=tick/trip.fps,
                                                       **sample(trip,tick/trip.fps))
                                                  for tick in range(trip.frame_count)])
        if trip.weather['mode'] == 'illustrative_replay':
            provenance['limitations'].append('Weather is explicitly replayed from other dates; not a trip-date forecast.')
        provenance['limitations'].append('Joint camera/Sun extinction with approximate multiple scattering.' if transport == 'joint'
            else 'Cloud and atmosphere transport are integrated as separate layers.')
        if trip.style['cloud_lighting']>0 and trip.weather['mode']!='clear':
            provenance['limitations'].append('Cloud lighting uses a finite four-term scattering approximation and three clear-sky directions attenuated by the cloud field; not a full angular multiple-scattering solve. Sky excludes below-horizontal atmosphere and neighboring-cloud bounce.')
        if trip.style['cloud_morphology'] and trip.weather['mode']!='clear':
            provenance['limitations'].append('Cellular billows use half-degree material maps and two smoothly renewed wind charts with at most four hours of history. Shapes, lifetime and coverage carving are modeled; sparse-cloud carving can reduce reconstructed optical mass and does not normalize each column.')
        if trip.style['moonlight']>0:
            provenance['limitations'].append(f"Shared cloud, terrain, ocean and Cycles aircraft moonlight uses the physical-UTC lunar ephemeris, nonlinear phase brightness, distance, local horizon and approximate eclipse attenuation; lunar flux is multiplied by {trip.style['moonlight']:g} for presentation. Direct surface/aircraft light is attenuated by shared air/cloud density; their legacy night fill is reduced to 20%. Lunar air scattering uses the shared geometry and attenuation. Surface bounce uses a bounded local same-albedo closure; terrain shadows sample 16 distances within 50 km and may miss thin/distant ridges. Earthshine, red eclipse glow, refraction and measured lunar spectrum are not modeled. Ocean roughness is an artistic constant.")
        if trip.style['cloud_city_glow']>0 and trip.weather['mode']!='clear':
            provenance['limitations'].append('City illumination of clouds uses a local nine-tap ground footprint and radial extinction column with bounded diffuse penetration; not full angular light transport.')
        if bundle.get('calibration'):
            provenance['limitations'].append('Local calibration preserves evidence dates and uncertainty. Survey point controls flatten and feather a modeled footprint; these are not surveyed runway meshes. Procedural material values are supplied central estimates, not a full measured BRDF; local GLB materials remain authored.')
        if bundle.get('environment'):
            provenance['limitations'].append('Dated environmental products use the explicit weather clock, including replay. AOD adds a modeled exponential aerosol layer above the clear-air baseline with fixed spectral exponent and scattering albedo; snow/ice fractions blend fixed artistic reflectances and suppress open-water glint. Secondary sky lookup retains the clear-air baseline. These material/vertical assumptions are not extra measurements.')
        if bundle.get('lighting_profile'):
            provenance['limitations'].append('Local lamp profiles are user-attributed measurements or models within declared dates/regions; their basis is not independently verified and default modeled priors remain elsewhere.')
        if bundle.get('aircraft_models'):
            provenance['limitations'].append('Selected local GLB geometry/materials use supplied dimensions and license metadata; remaining aircraft use procedural illustrations.')
        if not estimate_only:write_json(work/'provenance.json', provenance)
        from render_budget import set_timing_identity
        set_timing_identity(args,trip,work,environment)
        yield work, environment


def prepare_media(trip, work, ticks):
    if trip.moments:
        from media_moments import prepare_moments
        expected = json.loads((work/'provenance.json').read_text())['media_identity']
        return prepare_moments(trip, work, frames=ticks, expected_identity=expected)


def lighting_samples(trip, terrain=None, *, frames=None):
    """Dense frame-addressable list; unrequested preview frames are null.

    Weather attenuation reconstructs a global cloud field per timestamp. Only
    evaluate requested frames so a still preview does not pay for a full film.
    """
    import numpy as np
    from motion import Motion
    from frame_context import context_at, solar_visibility
    from moonlighting import lunar_incident
    motion = Motion(trip)
    selected=range(trip.frame_count) if frames is None else sorted(set(frames))
    if any(isinstance(tick,bool) or not isinstance(tick,int) or not 0<=tick<trip.frame_count for tick in selected):
        raise ValueError('Lighting frame indices must be integers within the trip')
    samples = [None]*trip.frame_count
    for tick in selected:
        ctx=context_at(motion,tick/trip.fps,terrain)
        basis=np.asarray(ctx.camera_basis)
        lunar,incident=lunar_incident(basis[2:3]*(1+max(0.,ctx.aircraft_altitude_m)/6371000.),
            ctx.physical_utc,ctx.weather_utc,strength=trip.style['moonlight'],
            with_weather=trip.weather['mode']!='clear')
        if terrain is not None and np.any(incident>0):
            from lunar_scattering import terrain_visibility
            incident*=terrain_visibility(basis[2:3]*(1+max(0.,ctx.aircraft_altitude_m)/6371000.),
                lunar.direction,lunar.angular_radius,terrain.sample)[:,None]
        from environmentlighting import aerosol_incident
        point=basis[2:3]*(1+max(0.,ctx.rendered_altitude_m)/6371000.)
        sun_rgb=aerosol_incident(point,ctx.sun_world,ctx.weather_utc)[0]
        samples[tick]={'sun_rgb':sun_rgb.tolist(),'frame':tick,'t':ctx.presentation_s,'utc':ctx.physical_utc.isoformat(),
                        'heading':ctx.heading_deg,'bank_deg':ctx.bank_deg,'pitch_deg':ctx.pitch_deg,
                        'attitude_mode':ctx.attitude_mode,'sun_camera':list(ctx.sun_camera),
                        'sun_visibility':solar_visibility(ctx.sun_camera[2],ctx.aircraft_altitude_m),
                        'moon_camera':(basis@lunar.direction[0]).tolist(),
                        'moon_rgb':incident[0].tolist(),
                        'moon_angular_diameter':float(2*lunar.angular_radius[0]),
                        'moonlight_enabled':trip.style['moonlight']>0,
                        'illustrative_altitude_m':ctx.aircraft_altitude_m,
                        'aircraft_altitude_m':ctx.aircraft_altitude_m,
                        'rendered_altitude_m':ctx.rendered_altitude_m,
                        'vertical_exaggeration':max(1.,trip.style['relief_exaggeration']),
                        'camera_distance_earth':ctx.camera_distance_earth,
                        'terrain_m':ctx.terrain_m,'trajectory_mode':ctx.trajectory_mode}
    return samples


def prepare_contexts(trip,work,bundle,asset_root, *, scene_frames=None):
    from motion import Motion
    from frame_context import context_at
    from terrain_detail import terrain_sampler
    terrain=terrain_sampler(str(Path(asset_root)/bundle['assets']['terrain']['path']),
                            tuple(str(Path(asset_root)/r['path']) for r in bundle.get('terrain_tiles',[])),
                            str(Path(asset_root)/bundle['calibration']['path']) if bundle.get('calibration') else None)
    motion=Motion(trip)
    contexts=[context_at(motion,tick/trip.fps,terrain).to_dict() for tick in range(trip.frame_count)]
    write_json(work/'frame-contexts.json',{'schema_version':1,'depth_unit':'Earth radius along normalized camera ray',
               'altitude_unit':'metres MSL','frames':contexts,
               'terrain_clearance_warnings':[{'frame':i,'clearance_m':c['terrain_clearance_m']}
                    for i,c in enumerate(contexts) if c['trajectory_mode'] in ('observed','track_interpolation','gap_interpolation') and c['terrain_clearance_m'] < -100]})
    # Every frame consumes one exact, immutable physical-time sample, regardless
    # of the order in which rendering workers request frames.
    physical_times=sorted(set(trip.travel_time(tick/trip.fps)
                              for tick in range(trip.frame_count)))
    from nightlighting import prepare_city_lights
    from scene_cache import missing_frames
    if scene_frames is not None and not missing_frames(scene_frames,trip=trip):
        metadata={'status':'reused physical scenes; no city-light prepass needed',
                  'scene_key':os.environ.get('FLIGHT_SCENE_KEY')}
    else:
        metadata=prepare_city_lights(trip,work,physical_times=physical_times)
    write_json(work/'prepass.json',{'city_lights':metadata,'frames':len(contexts)})
    return terrain


def valid_aircraft(path):
    import numpy as np
    try:
        with np.load(path,allow_pickle=False) as frame:
            rgb,alpha,depth=frame['radiance'],frame['alpha'],frame['depth']
            height,clearance=frame['model_camera_height_m'],frame['ground_clearance_m']
            bank,pitch=frame['bank_deg'],frame['pitch_deg']
            return (frame['schema_version'].shape==() and frame['schema_version']==2
                    and height.shape==() and clearance.shape==()
                    and bank.shape==() and pitch.shape==()
                    and np.isfinite(bank) and abs(bank)<90 and np.isfinite(pitch) and abs(pitch)<90
                    and np.isfinite(height) and height>0 and np.isfinite(clearance) and clearance>=0
                    and rgb.shape==(384,384,3)
                    and alpha.shape==(384,384,1) and depth.shape==(384,384)
                    and np.isfinite(rgb).all() and (rgb>=0).all()
                    and np.isfinite(alpha).all() and ((alpha>=0)&(alpha<=1)).all()
                    and not np.isnan(depth).any() and (depth>0).all()
                    and np.isfinite(depth[alpha[:,:,0]>0]).all()
                    and (depth[alpha[:,:,0]>0]>0).all())
    except (OSError,ValueError,TypeError,KeyError,EOFError):
        return False


def ranges(indices):
    start = end = None
    for index in sorted(set(indices)):
        if end is not None and index != end:
            yield start, end
            start = None
        if start is None:
            start = index
        end = index+1
    if start is not None:
        yield start, end


def prepare_aircraft(trip, work, ticks, blender, terrain=None, bundle=None, asset_root=None, frame_timeout=120.,
                     device=None, threads=2):
    from scene_cache import missing_frames
    # Scene validation is bounded to one frame at a time. Cached composites
    # already include Cycles light/depth and need no aircraft preparation.
    ticks = missing_frames(ticks,trip=trip)
    if not ticks:
        return {}
    from motion import Motion
    motion = Motion(trip)
    directory = work/'aircraft'
    directory.mkdir(exist_ok=True)
    device_record = device or {'backend':'cpu','devices':[{'name':'CPU','type':'CPU'}]}
    device_path = directory/'device.json'
    write_json(device_path, {key:value for key,value in device_record.items() if key != 'fallback_reason'})
    needed = {}
    for tick in ticks:
        for leg, _ in motion.aircraft_mix(tick/trip.fps):
            kind = trip.legs[leg].aircraft
            if not valid_aircraft(directory/('frames-'+kind)/f'frame-{tick:04d}.npz'):
                needed.setdefault(kind, []).append(tick)
    if not needed:return {}
    required=sorted({tick for indices in needed.values() for tick in indices})
    write_json(directory/'lighting-samples.json', lighting_samples(trip,terrain,frames=required))
    for kind, indices in needed.items():
        model = (bundle or {}).get('aircraft_models', {}).get(kind)
        extra = []
        if model:
            metadata = directory / (kind + '-asset.json')
            write_json(metadata, model)
            extra = ['--asset-model', str(Path(asset_root).expanduser().resolve() / model['path']),
                     '--asset-metadata', str(metadata)]
        for start, end in ranges(indices):
            log = directory/f'{kind}-{start}-{end}.log'
            command = [blender, '--factory-startup', '-b', '-t', str(threads), '--python-exit-code', '1', '--python', str(ENGINE/'aircraft_blender.py'),
                       '--', '--'+kind, '--all', '--start', str(start), '--end', str(end), '--threads', str(threads),
                       '--flight-cycles-device', device_record['backend'], '--device-record', str(device_path)] + extra
            print(f'Cycles {kind}: frames {start}–{end-1}', flush=True)
            with log.open('w') as handle:
                try:
                    completed = subprocess.run(command, stdout=handle, stderr=subprocess.STDOUT,
                                               timeout=300 + frame_timeout * (end - start))
                except subprocess.TimeoutExpired as exc:
                    raise RuntimeError(f'Blender exceeded its startup/frame time budget; diagnostics: {log}') from exc
            if completed.returncode:
                raise RuntimeError(f'Blender {device_record["backend"]} render failed; diagnostics: {log}. '
                                   'Use --cycles-device cpu for a separate CPU cache if GPU rendering failed.')
            for tick in range(start,end):
                if not valid_aircraft(directory/('frames-'+kind)/f'frame-{tick:04d}.npz'):
                    raise RuntimeError(f'Blender did not produce a valid frame {tick}; diagnostics: {log}')
    return needed


def valid_png(path, size):
    from PIL import Image
    try:
        with Image.open(path) as image:
            if image.size != size or image.format != 'PNG':
                return False
            image.verify()
        return True
    except (OSError, ValueError, SyntaxError):
        return False


def render_tick(tick):
    # Workers inherit immutable environment variables. All frame state is a
    # function of time; random evaluation order produces the same image.
    from runtime import WORK, TRIP
    started=time.perf_counter()
    from render import frame
    output = WORK/'frames'/f'{tick:06d}.png'
    if not valid_png(output, (1080,1920)):
        temporary = output.with_suffix('.tmp.png')
        frame(tick/TRIP.fps).save(temporary)
        temporary.replace(output)
        from scene_cache import last_event
        write_json(WORK/'frames'/f'{tick:06d}.timing.json',{'frame':tick,'seconds':time.perf_counter()-started,
            'scene_cache':last_event(), 'budget_fingerprint':os.environ.get('FLIGHT_BUDGET_FINGERPRINT')})
    return str(output)


def produce_frames(trip, work, ticks, workers):
    (work/'frames').mkdir(exist_ok=True)
    import multiprocessing
    with ProcessPoolExecutor(max_workers=workers, mp_context=multiprocessing.get_context('spawn')) as pool:
        for count, _ in enumerate(pool.map(render_tick, ticks, chunksize=1), 1):
            print(f'Frames ready {count}/{len(ticks)}', flush=True)


def contact_sheet(work, ticks):
    from PIL import Image
    columns = min(3, len(ticks))
    sheet = Image.new('RGB', (360*columns, 640*math.ceil(len(ticks)/columns)), (3, 8, 14))
    for i, tick in enumerate(ticks):
        with Image.open(work/'frames'/f'{tick:06d}.png') as image:
            sheet.paste(image.resize((360,640), Image.Resampling.LANCZOS), ((i%columns)*360, (i//columns)*640))
    sheet.save(work/'contact.jpg', quality=94)
    return work/'contact.jpg'


def verify_video(path, frame_count=None, fps=None):
    ffprobe, ffmpeg = executable('ffprobe'), executable('ffmpeg')
    if not ffprobe or not ffmpeg:
        raise ValueError('ffmpeg and ffprobe are required to verify exports.')
    result = json.loads(subprocess.check_output([ffprobe, '-v', 'error', '-show_streams',
                                                '-show_format', '-of', 'json', str(path)], text=True))
    streams = result['streams']
    videos = [stream for stream in streams if stream['codec_type'] == 'video']
    if len(videos) != 1 or len(streams) != 1:
        raise ValueError('Expected one silent video stream.')
    video = videos[0]
    if video['codec_name'] != 'h264' or video['pix_fmt'] != 'yuv420p' or video['width']*16 != video['height']*9:
        raise ValueError('Export must be 9:16 H.264 yuv420p.')
    if frame_count is not None and int(video['nb_frames']) != frame_count:
        raise ValueError('Export frame count does not match trip.')
    if fps is not None and video['r_frame_rate'] != f'{fps}/1':
        raise ValueError('Export frame rate does not match trip.')
    subprocess.run([ffmpeg, '-v', 'error', '-xerror', '-i', str(path), '-f', 'null', '-'], check=True)
    return {'decode': 'passed', 'width': video['width'], 'height': video['height'],
            'frames': int(video['nb_frames']), 'frame_rate': video['r_frame_rate'],
            'sha256': hashlib.sha256(Path(path).read_bytes()).hexdigest()}


def storytelling_options(parser):
    parser.add_argument('--aircraft-motion', action=argparse.BooleanOptionalAction, default=None,
                        help='Model bank and pitch from the physical flight path (Cycles only)')
    parser.add_argument('--pacing', choices=('classic', 'highlights'),
                        help='Emphasize endpoints and usable recorded climb, descent and turns')


def apply_storytelling_options(trip, args):
    motion, pacing = getattr(args, 'aircraft_motion', None), getattr(args, 'pacing', None)
    if motion is None and pacing is None:
        return trip
    data = trip.to_dict()
    if motion is not None:
        data['attitude'] = {**(trip.attitude or {}), 'enabled': motion}
    if pacing is not None:
        data['video']['pacing'] = pacing
    return trip_from_dict(data)


def telemetry_options(parser):
    storytelling_options(parser)
    parser.add_argument('--telemetry', action=argparse.BooleanOptionalAction, default=None,
                        help='Show distance traveled, MSL altitude and ground speed')
    parser.add_argument('--telemetry-units', choices=('aviation', 'metric'),
                        help='NM/FT/KT (default) or KM/M/KM/H; enables the overlay unless --no-telemetry')


def apply_telemetry_options(trip, args):
    if args.telemetry is None and args.telemetry_units is None:
        return trip
    data = trip.to_dict()
    config = dict(trip.telemetry or {'enabled': False, 'units': 'aviation'})
    config['enabled'] = args.telemetry if args.telemetry is not None else True
    if args.telemetry_units is not None:
        config['units'] = args.telemetry_units
    data['telemetry'] = config
    return trip_from_dict(data)


def import_track(trip, args):
    """Attach one selected segment, validate the whole itinerary, then create a new file."""
    from trajectory import read_track
    if not 1 <= args.flight <= len(trip.legs):
        raise ValueError(f'--flight must be between 1 and {len(trip.legs)} (one-based).')
    if trip.legs[args.flight-1].trajectory and not args.replace_trajectory:
        raise ValueError('This flight already has a trajectory; use --replace-trajectory to replace it in the new file.')
    data = trip.to_dict()
    data['flights'][args.flight-1]['trajectory'] = read_track(
        Path(args.track), args.source, format=args.format, segment=args.segment,
        altitude_reference=args.altitude_reference, altitude_offset_m=args.altitude_offset_m,
        date=args.date, max_gap_s=args.max_gap_s)
    updated = trip_from_dict(data)
    # Render snapshots use absolute inputs, but an imported trip is an editable
    # source document. Rebase its media references to the new file's location.
    saved = updated.to_dict()
    output_path = Path(args.output).expanduser()
    for moment in saved.get('moments', []):
        try:
            moment['path'] = os.path.relpath(moment['path'], output_path.resolve().parent)
        except ValueError:
            # Windows cannot express a relative reference across drive letters.
            # Keep the already-resolved target rather than changing its meaning.
            pass
    payload = json.dumps(saved, indent=2, allow_nan=False)+'\n'
    # Exclusive creation protects the original trip, the source track and prior imports.
    with Path(args.output).expanduser().open('x', encoding='utf-8') as handle:
        handle.write(payload)
    return {'output': str(Path(args.output).expanduser()), 'flight': args.flight,
            'points': len(updated.legs[args.flight-1].trajectory.points),
            'gaps': updated.legs[args.flight-1].trajectory.gaps(
                updated.legs[args.flight-1].depart, updated.legs[args.flight-1].arrive)}


def main(argv=None):
    startup_started=time.perf_counter()
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest='command', required=True)
    sub.add_parser('doctor')
    plan = sub.add_parser('plan')
    plan.add_argument('trip')
    telemetry_options(plan)
    track = sub.add_parser('import-track', help='Attach CSV, GPX, KML or IGC observations to one flight')
    track.add_argument('trip')
    track.add_argument('track')
    track.add_argument('--flight', required=True, type=int, help='One-based flight number')
    track.add_argument('--source', required=True, help='Recorder/export provenance')
    track.add_argument('--output', required=True, help='New trip JSON; existing files are never overwritten')
    track.add_argument('--replace-trajectory', action='store_true')
    track.add_argument('--format', choices=('auto','csv','gpx','kml','igc'), default='auto')
    track.add_argument('--segment', type=int, help='Zero-based segment index when the file contains several')
    track.add_argument('--altitude-reference', choices=('msl','ellipsoid'))
    track.add_argument('--altitude-offset-m', type=float)
    track.add_argument('--date', help='Explicit YYYY-MM-DD start date for IGC')
    track.add_argument('--max-gap-s', type=float, default=300.)
    telemetry_options(track)
    check = sub.add_parser('verify')
    check.add_argument('video')
    for name in ('preview', 'render', 'budget'):
        action = sub.add_parser(name)
        action.add_argument('trip')
        telemetry_options(action)
        action.add_argument('--assets', required=True, help='Directory containing bundle.json')
        action.add_argument('--workdir', default='renders', help='Cache and output parent; safe to resume')
        action.add_argument('--aircraft', choices=('cycles', 'diagram'), default='cycles')
        action.add_argument('--cycles-device', choices=('cpu', 'auto', 'metal'), default='cpu',
                            help='auto selects Metal or CPU at startup; later GPU errors stop the render')
        action.add_argument('--blender-threads', type=int, default=2,
                            help='CPU threads available to Blender (default: 2)')
        action.add_argument('--blender-probe-timeout', type=float, default=300.,
                            help='Seconds allowed for a cold Metal render probe; raise if shader compilation is slow')
        action.add_argument('--blender-frame-timeout', type=float, default=120.,
                            help='Seconds allowed per Cycles frame plus 300s startup; increase for slower machines/models')
        action.add_argument('--workers', type=int, default=2)
        action.add_argument('--compute', choices=('cpu','auto','metal'),default='cpu',
                            help='Optional MLX Metal air/cloud light integrals; auto falls back only during startup probe')
        action.add_argument('--transport', choices=('layered', 'joint'), default='layered',
                            help='Joint cloud/air integration is opt-in and more expensive')
        action.add_argument('--atmosphere-method', choices=('integrate', 'lookup'), default='integrate',
                            help='Reference clear-air integration or the bounded optical-depth lookup')
        action.add_argument('--cloud-view', choices=('reference', 'batched'), default='reference',
                            help='Reference cloud marcher or the batched Metal view pass where supported')
        action.add_argument('--atmosphere-view', choices=('reference', 'batched'), default='reference',
                            help='Reference atmospheric marcher or batched Metal scattering and accumulation')
        action.add_argument('--cloud-source', choices=('reference', 'batched'), default='reference',
                            help='Reference or batched sky, lunar and city cloud lighting queries')
        action.add_argument('--volume-reconstruction', choices=('reference', 'adaptive', 'full'), default='reference',
                            help='Bilinear reference, depth-aware adaptive rays, or full spatial volume sampling')
        action.add_argument('--scene-cache', choices=('on', 'off'), default='on',
                            help='Reuse HDR scenes for overlay edits; off avoids extra scene-cache disk usage')
        action.add_argument('--quality',choices=('preview','delivery','high'),default='delivery',
                            help='Sampling budget; geometry, dates and weather seed stay identical')
        if name == 'render':
            action.add_argument('--encoder', choices=('x264', 'videotoolbox'), default='x264',
                                help='VideoToolbox requires local Apple hardware; uses the same cached frames')
        if name in ('preview','budget'):
            action.add_argument('--frames', help='Comma-separated zero-based frame indices')
        if name == 'budget':
            action.add_argument('--samples',type=int,default=3,help='Representative benchmark frames (1–12)')
            action.add_argument('--estimate-only',action='store_true',help='Read existing timings without rendering')
            action.add_argument('--report',help='Write the JSON estimate to this path')
            action.add_argument('--budget-timeout',type=float,default=1800.,help='Maximum benchmark child time in seconds')
    args = parser.parse_args(argv)
    try:
        if args.command == 'doctor':
            print(json.dumps(doctor(), indent=2)); return
        if args.command == 'verify':
            print(json.dumps(verify_video(Path(args.video)), indent=2)); return
        trip = apply_storytelling_options(apply_telemetry_options(load_trip(args.trip), args), args)
        if args.command == 'import-track':
            print(json.dumps(import_track(trip, args), indent=2)); return
        if args.command == 'plan':
            print(json.dumps(trip.to_plan(), indent=2)); return
        if args.workers < 1:
            raise ValueError('--workers must be positive.')
        if not 1 <= args.blender_threads <= 1024:
            raise ValueError('--blender-threads must be between 1 and 1024.')
        if not math.isfinite(args.blender_probe_timeout) or not 0 < args.blender_probe_timeout <= 86400:
            raise ValueError('--blender-probe-timeout must be positive and at most 86400 seconds.')
        if not math.isfinite(args.blender_frame_timeout) or not 0 < args.blender_frame_timeout <= 86400:
            raise ValueError('--blender-frame-timeout must be positive and at most 86400 seconds.')
        from data import validate_bundle
        month = trip.legs[0].depart.astimezone(ZoneInfo(trip.legs[0].origin.timezone)).month
        bundle = validate_bundle(args.assets, trip.weather['mode'], trip.weather_time(0),
                                 trip.weather_time(trip.duration_s), month)
        if args.command == 'render' and not executable('ffmpeg'):
            raise ValueError('ffmpeg is required to encode the video.')
        encoding = None
        if args.command == 'render':
            from acceleration import probe_encoder
            encoding = probe_encoder(executable('ffmpeg'), args.encoder)
        with configure(args, trip, bundle) as (work, environment):
            if args.command=='budget':
                from render_budget import run_budget
                report=run_budget(args,trip,bundle,work,environment,
                                  startup_seconds=time.perf_counter()-startup_started)
                print(json.dumps(report,indent=2));return
            from labels import Labels
            from motion import Motion
            write_json(work/'labels.json', Labels(Motion(trip)).report())
            if args.command == 'preview':
                if args.frames:
                    ticks = sorted(set(int(x) for x in args.frames.split(',')))
                else:
                    ticks = sorted(set([0, trip.frame_count-1] + [min(trip.frame_count-1, round(t*trip.fps))
                                        for start,end in trip.leg_intervals for t in ((start+end)/2, end)]))
                if not ticks or any(t < 0 or t >= trip.frame_count for t in ticks):
                    raise ValueError(f'Preview indices must lie between 0 and {trip.frame_count-1}.')
            else:
                ticks = list(range(trip.frame_count))
            prepare_media(trip, work, ticks)
            terrain=prepare_contexts(trip,work,bundle,Path(args.assets).expanduser().resolve(),scene_frames=ticks)
            if args.aircraft == 'cycles':
                prepare_aircraft(trip, work, ticks, environment['tools']['blender'],terrain,bundle,args.assets,
                                 frame_timeout=args.blender_frame_timeout, device=environment['cycles_device'],
                                 threads=args.blender_threads)
            produce_frames(trip, work, ticks, args.workers)
            timings=[json.loads(p.read_text())['seconds'] for p in (work/'frames').glob('*.timing.json')]
            write_json(work/'performance.json',{'scope':'cumulative timings for this immutable render cache',
                'requested_frames_this_invocation':len(ticks),'quality':args.quality,'workers':args.workers,
                'timed_frames':len(timings),'mean_frame_seconds':sum(timings)/len(timings) if timings else None,
                'max_frame_seconds':max(timings) if timings else None})
            if args.command == 'preview':
                print(contact_sheet(work, ticks)); return
            stem = 'video' if args.encoder == 'x264' else 'video-videotoolbox'
            output = work/(stem+'.mp4')
            temporary = work/(stem+'.rendering.mp4')
            encoding_started = time.perf_counter()
            metadata = f"Weather mode: {trip.weather['mode']}; historical surface; recorded waypoints where supplied, illustrative routing otherwise. See provenance.json."
            subprocess.run([executable('ffmpeg'), '-y', '-v', 'error', '-framerate', str(trip.fps),
                            '-i', str(work/'frames'/'%06d.png'), '-frames:v', str(trip.frame_count), '-an',
                            *encoding['arguments'], '-pix_fmt', 'yuv420p',
                            '-movflags', '+faststart', '-metadata', 'title='+trip.title, '-metadata', 'comment='+metadata,
                            str(temporary)], check=True)
            encoding['seconds'] = time.perf_counter()-encoding_started
            report = verify_video(temporary, trip.frame_count, trip.fps)
            report['encoding'] = encoding
            temporary.replace(output)
            write_json(work/('verification.json' if args.encoder == 'x264' else 'verification-videotoolbox.json'), report)
            print(output)
    except (ValueError, OSError, OverflowError, RuntimeError, subprocess.CalledProcessError) as exc:
        parser.exit(2, f'Error: {exc}\n')


if __name__ == '__main__':
    main()
