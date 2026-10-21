"""Create dimensional airliners and render sun-lit, transparent per-frame sprites.

Run with Blender, e.g.:
  blender -b --python aircraft_blender.py -- --preview
  blender -b --python aircraft_blender.py -- --all
  blender -b --python aircraft_blender.py -- --a321neo --all
  blender -b --python aircraft_blender.py -- --777-200er --all
  blender -b --python aircraft_blender.py -- --787-9 --validate-only
  blender -b --python aircraft_blender.py -- --787-9 --all
  blender -b --python aircraft_blender.py -- --757-300 --all

The camera looks down +Z toward the XY plane. A northbound aircraft points +Y.
lighting-samples.json is produced by the parent globe renderer and is authoritative.
"""
from pathlib import Path
import argparse
import json
import math
import sys
import time
import shutil
import tempfile
import numpy as np

import bpy
from mathutils import Matrix, Vector
sys.path.insert(0,str(Path(__file__).resolve().parent))
sys.path.insert(0,str(Path(__file__).resolve().parent.parent))
from quality import get_quality

import os
ASSETS = Path(os.environ['FLIGHT_AIRCRAFT_DIR'])
ASSETS.mkdir(parents=True, exist_ok=True)
SPRITES = ASSETS / 'frames'
SPRITES.mkdir(exist_ok=True)
VARIANT = next((name for name in ('a321neo', '777-200er', '787-9', '757-300')
                if '--'+name in sys.argv), None)
CINEMATIC = '--cinematic' in sys.argv or VARIANT is not None
FLEX_OBJECTS = []
FLEX_LAMPS = []
BEACON = None
ENVIRONMENT = None
MOON = None
ASSET_MODEL = None
ASSET_METADATA = None
ASSET_GEOMETRY = None
MATERIAL_CALIBRATION = {}
SUN_COLOR = (1.,1.,1.)

AIRFRAME_SPECS = {
    'a321neo': {
        'name': 'Airbus A321neo', 'length_m': 44.51, 'span_m': 35.80,
        'fuselage_width_m': 3.95, 'tailplane_span_m': 12.45,
        'engine_center_offset_m': 5.75, 'engine_lip_aft_nose_m': 15.40,
        'wingtip': 'Upturned Airbus sharklets',
        'leg': None, 'registration': None,
        'reference': 'https://www.aircraft.airbus.com/sites/g/files/jlcbta126/files/2023-12/ac_a321_1223.pdf',
        'reference_pages': 'A321neo general dimensions, section 2-2-0, pages 6–7 (PDF pages 45–46)',
        'equipment_evidence': 'Aircraft type supplied in trip configuration; no airline, registration, engine option or live assignment is asserted.',
    },
    '777-200er': {
        'name': 'Boeing 777-200ER', 'length_m': 63.73, 'span_m': 60.93,
        'fuselage_width_m': 6.20, 'tailplane_span_m': 21.53,
        'engine_center_offset_m': 9.61, 'engine_lip_aft_nose_m': None,
        'wingtip': 'Conventional tapered tips; no winglets or 777-300ER raked tips',
        'leg': None, 'registration': None,
        'reference': 'https://www.boeing.com/content/dam/boeing/v2/airports/acaps/777-200-200ER-300_Rev_E.pdf',
        'reference_pages': 'General dimensions, section 2.2.1, page 2-8 (PDF page 20)',
        'equipment_evidence': 'Aircraft type supplied in trip configuration; no airline, registration, engine option or live assignment is asserted.',
    },

    '787-9': {
        'name': 'Boeing 787-9', 'length_m': 62.81, 'span_m': 60.12,
        'fuselage_width_m': 5.77, 'fuselage_height_m': 5.94,
        'tailplane_span_m': 19.81, 'engine_center_offset_m': 9.91,
        'engine_lip_aft_nose_m': 20.80,
        'wingtip': 'Continuous swept and raked tips; no vertical winglets',
        'leg': None, 'registration': None,
        'reference': 'https://www.boeing.com/content/dam/boeing/v2/airports/acaps/787_Rev_P.pdf',
        'reference_pages': 'D6-58333 Rev P, December 2024, section 2.2.2, page 2-6 (PDF page 21)',
        'detail_sources': [
            'https://www.boeing.com/commercial/787/by-design',
            'https://www.nasa.gov/aeronautics/nasa-helps-create-a-more-silent-night/',
        ],
        'equipment_evidence': 'Aircraft type supplied in trip configuration; no airline, registration, engine option or live assignment is asserted.',
        'geometry_notes': 'Dimensioned overall envelope and simplified three-view planform. Nacelle fan-cowl chevrons are modeled as geometry; their count/depth and inlet diameter are illustrative, not an assertion of a specific installed engine option.',
    },
    '757-300': {
        'name': 'Boeing 757-300', 'length_m': 54.43, 'span_m': 41.10,
        'baseline_span_m': 38.06, 'fuselage_width_m': 3.76,
        'tailplane_span_m': 15.22, 'engine_center_offset_m': 6.50,
        'engine_lip_aft_nose_m': 20.90,
        'wingtip': 'APB conventional upward blended winglets; no split/scimitar lower blade',
        'leg': None, 'registration': None,
        'reference': 'https://www.boeing.com/content/dam/boeing/v2/airports/acaps/757_Rev_H.pdf',
        'reference_pages': 'D6-58327 Rev H, December 2024, section 2.2.2, page 2-11 (PDF page 21)',
        'detail_sources': [
            'https://www.boeing.com/content/dam/boeing/v2/airports/faq/wingletspans.pdf',
            'https://www.aviationpartnersboeing.com/products_757_300.php',
            'https://aviationpartnersboeing.com/pdf/pr/2011/110620_united_order.pdf',
        ],
        'equipment_evidence': 'Aircraft type supplied in trip configuration; no airline, registration, engine option or live assignment is asserted.',
        'geometry_notes': 'Boeing baseline span 38.06 m; Boeing winglet-span reference rounds the APB-equipped span to 41.1 m. Winglet height/curvature and nacelle shape are simplified; the engine-lip station uses the Rolls-Royce envelope in the planning drawing.',
    },

}


def adapt_airframe(variant):
    """Dimension the reusable mesh from manufacturer planning three-views.

    All aircraft retain a 12.01-unit fuselage length to keep the same screen
    footprint. This is a recognizable, dimensioned visualization, not CAD.
    Transform coordinates in the aircraft frame, including rotated fan meshes.
    """
    if variant in ('787-9', '757-300'):
        return adapt_return_airframe(variant)
    spec=AIRFRAME_SPECS[variant]
    aircraft.name=spec['name']+' centered display model'
    unit=spec['length_m']/12.01
    body_x=(spec['fuselage_width_m']/unit/2)/.59
    body_z=(spec['fuselage_width_m']/unit/2)/.61
    tail_x=(spec['tailplane_span_m']/unit/2)/2.42
    main_x=(spec['span_m']/unit/2)/(5.91 if variant=='a321neo' else 5.78)
    engine_x=spec['engine_center_offset_m']/unit
    engine_radius=.90 if variant=='a321neo' else .91

    def nose_y(y):
        return float(np.interp(y,[-6.25,-3.2,2.95,4.15,4.8,5.35,5.68,5.76],
                               [-6.25,-3.2,3.97,4.65,5.1,5.48,5.70,5.76]))

    def map_wing(x,y,z):
        span=abs(x)
        if variant=='a321neo':
            return x*main_x,.68*y+.40,z
        # Map both edges to the 777-200 manufacturer's tapered outline. This
        # preserves the control-surface detail while correcting chord/sweep.
        old_le=float(np.interp(span,[.4,1.7,5.65,5.91],[1,.28,-2.05,-2.05]))
        old_te=float(np.interp(span,[.4,2.,5.25,5.78],[-1.59,-1.71,-2.75,-2.68]))
        chord_fraction=(y-old_te)/(old_le-old_te)
        new_le=float(np.interp(span,[.4,1.7,5.65,5.78],[1.69,.91,-1.767,-1.80]))
        new_te=float(np.interp(span,[.4,1.9,5.78],[-.78,-.78,-2.166]))
        return x*main_x,new_te+chord_fraction*(new_le-new_te),z

    def transform_point(name,point):
        x,y,z=point
        side=-1 if x<0 else 1
        if name.startswith(('port','starboard')):
            if 'tailplane' in name or 'elevator' in name:
                x*=tail_x
                y=.75*y-1.45 if variant=='a321neo' else .98*y-.24
            elif 'pylon' in name:
                x=side*engine_x+(x-side*1.93)*engine_radius
                y=.8*y+(.96 if variant=='a321neo' else 1.34)
            elif any(term in name for term in ['nacelle','intake','fan','exhaust']):
                x=side*engine_x+(x-side*1.93)*engine_radius
                z=-.44+(z+.44)*engine_radius
                y=(.48*y+1.10) if variant=='a321neo' else (.55*y+1.33)
            elif 'position light' in name:
                if variant=='a321neo':
                    x*=main_x;y=.68*y+.40;z=1.11
                else:
                    x=side*(spec['span_m']/unit/2-.025);y=-1.98;z=.50
            else:
                x,y,z=map_wing(x,y,z)
                if 'winglet' in name:
                    z=.43+(z-.43)*1.18
        elif 'Vertical tail' in name:
            z*=.91 if variant=='a321neo' else 1.0
        elif 'aft position' in name:
            z*=body_z
        else:
            x*=body_x;z*=body_z
            if 'fuselage' in name or 'cockpit' in name:
                y=nose_y(y)
        # Longitudinal fuselage midpoint is exactly the sprite anchor.
        return Vector((x,y+.245,z))

    bpy.context.view_layer.update()
    FLEX_LAMPS.clear()
    for ob in list(aircraft.children):
        if variant=='777-200er' and 'winglet' in ob.name:
            bpy.data.objects.remove(ob,do_unlink=True)
            continue
        if 'light' in ob.name or 'beacon' in ob.name:
            ob.location=transform_point(ob.name,ob.location)
            if 'position light' in ob.name and ob.name.startswith(('port','starboard')):
                FLEX_LAMPS.append((ob,ob.location.copy()))
            continue
        matrix=ob.matrix_local.copy();inverse=matrix.inverted()
        if ob.type=='MESH':
            for vertex in ob.data.vertices:
                vertex.co=inverse@transform_point(ob.name,matrix@vertex.co)
        elif ob.type=='CURVE':
            for spline in ob.data.splines:
                for point in spline.points:
                    co=inverse@transform_point(ob.name,matrix@Vector(point.co[:3]))
                    point.co=(*co,1)
    bpy.context.view_layer.update()


def adapt_return_airframe(variant):
    """Build the return types from their dimensioned Boeing three-views.

    Planform stations are hand-sampled from the cited drawings, in metres
    (lateral distance, distance aft of nose, height above body centre). Overall
    dimensions are exact inputs; local aerofoil/dihedral/winglet contours are
    deliberately simplified. Every type keeps the same centered display length.
    """
    spec = AIRFRAME_SPECS[variant]
    aircraft.name = spec['name']+' centered display model'
    unit = spec['length_m']/12.01
    wide = variant == '787-9'
    body_x = spec['fuselage_width_m']/(2*unit*.59)
    body_z = spec.get('fuselage_height_m', spec['fuselage_width_m']*1.06)/(2*unit*.61)
    engine_x = spec['engine_center_offset_m']/unit
    # Approximate family nacelle envelopes, not installed engine CAD.
    engine_radius = (3.65 if wide else 2.45)/(unit*.82)
    engine_scale_y = (5.20 if wide else 4.20)/(unit*2.135)
    engine_front = 5.76-spec['engine_lip_aft_nose_m']/unit
    engine_z = -(.44 if wide else .37)
    if wide:
        leading = [(2.60,21.80,.00),(7.00,24.10,.30),(15.00,28.50,1.00),
                   (23.50,34.80,1.90),(27.50,38.70,2.70),
                   (29.00,40.69,3.00),(30.06,43.36,3.25)]
        trailing = [(30.06,43.36,3.25),(28.00,42.10,2.82),
                    (24.00,40.20,2.10),(16.00,37.50,1.00),
                    (8.30,34.10,.30),(2.60,34.10,.00)]
        tail_stations = (49.4,56.7,59.5,60.4)
        fin_height = 9.8/unit
    else:
        leading = [(1.50,22.20,.00),(6.50,24.70,.35),
                   (12.00,27.60,.90),(19.03,31.03,1.45)]
        trailing = [(19.03,33.19,1.45),(16.00,32.50,1.20),
                    (7.00,29.00,.40),(1.50,28.49,.00)]
        tail_stations = (44.8,51.0,52.8,53.3)
        fin_height = 9.5/unit
    half_span = spec.get('baseline_span_m',spec['span_m'])/2
    tail_half = spec['tailplane_span_m']/2

    def station(points, x, axis):
        ordered=sorted(points)
        return float(np.interp(x,[p[0] for p in ordered],[p[axis] for p in ordered]))

    def wing_map(x,y,z):
        old_span=abs(x)
        distance=old_span/5.78*half_span
        old_le=float(np.interp(old_span,[.4,1.7,5.65,5.91],[1,.28,-2.05,-2.05]))
        old_te=float(np.interp(old_span,[.4,2.,5.25,5.78],[-1.59,-1.71,-2.75,-2.68]))
        fraction=np.clip((y-old_te)/(old_le-old_te),0,1)
        front=station(leading,distance,1); back=station(trailing,distance,1)
        aft=back+fraction*(front-back)
        # Existing joint/leading-edge curves remain on the new top surface.
        height=station(leading,distance,2)/unit+.077
        return math.copysign(distance/unit,x),5.76-aft/unit,height

    def transform_point(name,point):
        x,y,z=point
        side=-1 if x<0 else 1
        if name.startswith(('port','starboard')):
            if 'tailplane' in name or 'elevator' in name:
                span=abs(x)/2.42
                old_le=float(np.interp(abs(x),[.3,2.35],[-4.33,-5.39]))
                old_te=float(np.interp(abs(x),[.22,2.42],[-5.63,-5.89]))
                fraction=(y-old_te)/(old_le-old_te)
                le=np.interp(span,[0,1],tail_stations[:2])
                te=np.interp(span,[0,1],tail_stations[2:])
                x=side*span*tail_half/unit
                y=5.76-(te+fraction*(le-te))/unit
                z*=.85 if wide else .78
            elif 'pylon' in name:
                x=side*engine_x+(x-side*1.93)*engine_radius
                y=engine_front+(y-1.055)*engine_scale_y
                z=engine_z+(z+.44)*engine_radius
            elif any(term in name for term in ['nacelle','intake','fan','exhaust']):
                x=side*engine_x+(x-side*1.93)*engine_radius
                y=engine_front+(y-1.055)*engine_scale_y
                z=engine_z+(z+.44)*engine_radius
            elif 'position light' in name:
                if wide:
                    x=side*(half_span-.15)/unit
                    y=5.76-43.10/unit;z=3.25/unit+.045
                else:
                    x=side*(spec['span_m']/2-.07)/unit
                    y=5.76-33.10/unit;z=4.0/unit+.045
            else:
                x,y,z=wing_map(x,y,z)
        elif 'Vertical tail' in name:
            z*=fin_height/2.35
            y=.94*y-.32 if wide else .88*y-.66
        elif 'aft position' in name:
            z*=body_z
        else:
            x*=body_x;z*=body_z
            if 'fuselage' in name or 'cockpit' in name:
                # Keep a long constant-width barrel, with a 787's smoothly
                # descending forehead and the 757's longer narrow nose.
                new_nose = ([3.72,4.48,4.96,5.39,5.68,5.76] if wide else
                            [3.90,4.57,5.00,5.40,5.68,5.76])
                y=float(np.interp(y,[-6.25,-3.2,2.95,4.15,4.8,5.35,5.68,5.76],
                                  [-6.25,-3.2]+new_nose))
        return Vector((x,y+.245,z))

    bpy.context.view_layer.update()
    FLEX_LAMPS.clear()
    wing_material=None;winglet_material=None
    for ob in list(aircraft.children):
        if 'swept main wing' in ob.name:
            wing_material=ob.data.materials[0]
            bpy.data.objects.remove(ob,do_unlink=True)
            continue
        if 'blended winglet' in ob.name:
            winglet_material=ob.data.materials[0]
            bpy.data.objects.remove(ob,do_unlink=True)
            continue
        if 'light' in ob.name or 'beacon' in ob.name:
            ob.location=transform_point(ob.name,ob.location)
            if 'position light' in ob.name and ob.name.startswith(('port','starboard')):
                FLEX_LAMPS.append((ob,ob.location.copy()))
            continue
        matrix=ob.matrix_local.copy();inverse=matrix.inverted()
        if ob.type=='MESH':
            for vertex in ob.data.vertices:
                vertex.co=inverse@transform_point(ob.name,matrix@vertex.co)
        elif ob.type=='CURVE':
            for spline in ob.data.splines:
                for point in spline.points:
                    co=inverse@transform_point(ob.name,matrix@Vector(point.co[:3]))
                    point.co=(*co,1)

    for side,sign in (('port',-1),('starboard',1)):
        def model_points(points):
            return [(sign*x/unit,6.005-aft/unit,z/unit) for x,aft,z in points]
        outline=leading+trailing[1:] if wide else leading+trailing
        wing(side+' swept main wing',model_points(outline),.12,wing_material)
        if not wide:
            wing(side+' conventional blended winglet',model_points([
                (19.03,31.03,1.45),(19.35,31.40,1.70),
                (19.95,31.90,2.50),(20.55,32.60,4.00),
                (20.50,33.50,4.00),(19.70,33.30,2.50),
                (19.03,33.19,1.45)]),.055,winglet_material)
    bpy.context.view_layer.update()


def cinematic_environment(scene):
    """Analytic HDR Earth/sky environment, aligned to local vertical and Sun.

    This is an atmospheric reflection approximation, not a photographic HDRI.
    Earth is always the lower hemisphere, independently of aircraft heading.
    """
    global ENVIRONMENT
    nodes=scene.world.node_tree.nodes
    links=scene.world.node_tree.links
    env=nodes.new('ShaderNodeTexEnvironment')
    env.name='Local Earth and sky reflection environment'
    ENVIRONMENT=bpy.data.images.new('Earth-sky radiance',width=512,height=256,
                                   alpha=True,float_buffer=True)
    env.image=ENVIRONMENT
    links.new(env.outputs['Color'],nodes.get('Background').inputs['Color'])
    nodes.get('Background').inputs['Strength'].default_value=1.0


def update_environment(sample):
    # Equirectangular longitude/latitude layout; the frame axes are east,
    # geographic north and up. The environment changes with solar elevation.
    # Blender's equirectangular mapping is u=(pi-atan2(y,x))/(2*pi).
    longitude=np.pi-(np.arange(512,dtype=np.float32)+.5)/512*2*np.pi
    latitude=(np.arange(256,dtype=np.float32)+.5)/256*np.pi-np.pi/2
    lon,lat=np.meshgrid(longitude,latitude)
    z=np.sin(lat)
    directions=np.stack((np.cos(lat)*np.cos(lon),np.cos(lat)*np.sin(lon),z),-1)
    sun=np.asarray(sample['sun_camera'],dtype=np.float32)
    daylight=float(np.clip((sun[2]+.10)/.45,0,1))
    night_floor=.20 if sample.get('moonlight_enabled',False) else 1.
    # Legacy samples preserve their approved floor. Shared Moon lighting keeps
    # only twenty percent of that night fill, even below the lunar horizon.
    sky=np.array([.006,.010,.018])*(1-daylight)*night_floor+np.array([.08,.14,.25])*daylight
    earth=np.array([.003,.005,.008])*(1-daylight)*night_floor+np.array([.05,.07,.08])*daylight
    mix=np.clip((z+.025)/.05,0,1)[...,None]
    rgb=earth*(1-mix)+sky*mix
    horizon=np.exp(-(z/.09)**2)
    toward_sun=np.maximum(directions@sun,0)**12
    sunset=np.exp(-(float(sun[2])/.22)**2)
    rgb+=horizon[...,None]*(np.array([.07,.12,.20])*(night_floor+(1-night_floor)*daylight)
                           +toward_sun[...,None]*np.array([.60,.26,.08])*sunset)
    # Broad cloud luminance in the ground hemisphere is bounded and deliberately
    # smooth. It represents local cloud reflection, not a new weather forecast.
    clouds=(.5+.5*np.sin(lon*3.3+.8)*np.cos(lat*7.1-.4))**4
    rgb+=((z<-.12)*clouds*(.001*(night_floor+(1-night_floor)*daylight)+.03*daylight))[...,None]
    rgba=np.ones((256,512,4),dtype=np.float32);rgba[...,:3]=rgb
    ENVIRONMENT.pixels.foreach_set(rgba.ravel())
    ENVIRONMENT.update()
    # Repack and tag the changed image/world: Cycles may otherwise keep using
    # the first pixels across poses, especially with persistent render data.
    ENVIRONMENT.pack()
    ENVIRONMENT.update_tag()
    bpy.context.scene.world.node_tree.update_tag()
    bpy.context.scene.world.update_tag()


def lamp(name,location,color,radius=.065,strength=4.5):
    mat=material(name+' lens',color,0,.18)
    p=mat.node_tree.nodes.get('Principled BSDF')
    p.inputs['Emission Color'].default_value=(*color,1)
    p.inputs['Emission Strength'].default_value=strength
    bpy.ops.mesh.primitive_uv_sphere_add(segments=16,ring_count=8,radius=radius,
                                       location=location)
    ob=bpy.context.object;ob.name=name;ob.parent=aircraft
    ob.data.materials.append(mat)
    for face in ob.data.polygons: face.use_smooth=True
    return ob,p


def prepare_flex():
    for ob in list(aircraft.children):
        eligible=ob.name.startswith(('port','starboard')) and not any(
            term in ob.name for term in ['tailplane','elevator','position light'])
        if not eligible: continue
        if ob.type=='MESH':
            FLEX_OBJECTS.append((ob, 'MESH',[v.co.copy() for v in ob.data.vertices]))
        elif ob.type=='CURVE':
            FLEX_OBJECTS.append((ob,'CURVE',[[p.co.copy() for p in s.points] for s in ob.data.splines]))


def update_flex(sample):
    elevation=max(0,min(1,sample['illustrative_altitude_m']/11000))
    phase=elevation*elevation*(3-2*elevation)
    flex=.18*phase*(1+.06*math.sin(sample['t']*1.7))
    tip_span = 5.9
    if VARIANT in ('787-9','757-300'):
        spec=AIRFRAME_SPECS[VARIANT]
        tip_span=spec['span_m']/(2*(spec['length_m']/12.01))
    def amount(x): return flex*(min(1,max(0,(abs(x)-.4)/(tip_span-.4)))**1.7)
    for ob,kind,base in FLEX_OBJECTS:
        transform=ob.matrix_local.copy()
        inverse_rotation=transform.inverted().to_3x3()
        if kind=='MESH':
            for vert,point in zip(ob.data.vertices,base):
                world_point=transform@point
                vert.co=point+inverse_rotation@Vector((0,0,amount(world_point.x)))
        else:
            for spline,points in zip(ob.data.splines,base):
                for vert,point in zip(spline.points,points):
                    world_point=transform@Vector(point[:3])
                    delta=inverse_rotation@Vector((0,0,amount(world_point.x)))
                    vert.co=point+Vector((*delta,0))
    for ob,base in FLEX_LAMPS:
        ob.location=base;ob.location.z+=amount(base.x)
    # Slow, soft beacon cadence uses presentation seconds, not accelerated UTC.
    pulse=((sample['t']-.18)%1.2)/.22
    intensity=math.sin(math.pi*pulse)**2 if pulse<1 else 0
    BEACON.inputs['Emission Strength'].default_value=.15+3.6*intensity
    return round(flex,7),round(intensity,7)


def import_aircraft_model():
    """Orient a static local glTF model, retaining its imported PBR materials."""
    global ASSET_GEOMETRY
    from aircraft_assets import validate_aircraft_model
    validate_aircraft_model(ASSET_MODEL, ASSET_METADATA)
    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=str(ASSET_MODEL), import_pack_images=True)
    imported = set(bpy.data.objects) - before
    excluded = {'cameras': sum(ob.type == 'CAMERA' for ob in imported),
                'lights': sum(ob.type == 'LIGHT' for ob in imported)}
    # Authored scene lights/cameras must not compete with the shared itinerary
    # Sun and crop. Freeze geometry only; animation/skins are rejected earlier.
    for ob in list(imported):
        if ob.type in ('LIGHT', 'CAMERA'):
            for child in list(ob.children):
                world = child.matrix_world.copy()
                child.parent = ob.parent
                child.matrix_world = world
            imported.remove(ob)
            bpy.data.objects.remove(ob, do_unlink=True)
    meshes = [ob for ob in imported if ob.type == 'MESH']
    if not meshes:
        raise ValueError('Aircraft GLB did not import any mesh objects')
    def axis(value):
        vector = Vector((0., 0., 0.))
        vector['XYZ'.index(value[1])] = 1 if value[0] == '+' else -1
        return vector
    nose, up = axis(ASSET_METADATA['nose_axis']), axis(ASSET_METADATA['up_axis'])
    # Blender's glTF importer maps X,Y,Z -> X,-Z,Y. Undo that basis before
    # applying the declared source nose/up, giving screen-right,+Y nose,+Z up.
    rotation = Matrix((nose.cross(up), nose, up)) @ Matrix(((1,0,0),(0,0,1),(0,-1,0)))
    bpy.context.view_layer.update()
    points = np.asarray([tuple(rotation @ (ob.matrix_world @ Vector(corner)))
                         for ob in meshes for corner in ob.bound_box])
    if not np.isfinite(points).all():
        raise ValueError('Aircraft GLB contains nonfinite mesh bounds')
    low, high = points.min(axis=0), points.max(axis=0)
    span, length, height = high-low
    if min(span, length) <= 1e-8:
        raise ValueError('Aircraft GLB has no measurable length or wingspan in the declared axes')
    ratio = ASSET_METADATA['wingspan_m']/ASSET_METADATA['length_m']
    if abs(span/length/ratio-1) > .05:
        raise ValueError('Aircraft GLB span/length ratio differs from declared dimensions by over 5%; check axes and dimensions')
    factor = 12.01/length
    transform = Matrix.Scale(factor, 4) @ Matrix.Translation(-Vector((low+high)/2)) @ rotation.to_4x4()
    for ob in imported:
        if ob.parent not in imported:
            world = ob.matrix_world.copy()
            ob.parent = aircraft
            ob.matrix_world = transform @ world
    aircraft.name = 'User-supplied static aircraft model'
    bpy.context.view_layer.update()
    ASSET_GEOMETRY = {'length_m': ASSET_METADATA['length_m'],
                      'wingspan_m': float(span/length*ASSET_METADATA['length_m']),
                      'height_m': float(height/length*ASSET_METADATA['length_m']),
                      'metres_per_display_unit': ASSET_METADATA['length_m']/12.01,
                      'mesh_count': len(meshes), 'bounds_centered': True,
                      'excluded_scene_objects': excluded,
                      'declared_glTF_nose_axis': ASSET_METADATA['nose_axis'],
                      'declared_glTF_up_axis': ASSET_METADATA['up_axis']}


def material(name, color, metallic=0.0, roughness=0.35):
    m = bpy.data.materials.new(name)
    m.diffuse_color = (*color, 1)
    m.use_nodes = True
    p = m.node_tree.nodes.get('Principled BSDF')
    p.inputs['Base Color'].default_value = (*color, 1)
    p.inputs['Metallic'].default_value = metallic
    p.inputs['Roughness'].default_value = roughness
    return m


def apply_material_calibration(slots):
    """Override only declared procedural slots; imported GLB materials stay authored."""
    global MATERIAL_CALIBRATION
    MATERIAL_CALIBRATION={}
    root=os.environ.get('FLIGHT_ASSET_DIR')
    if not root:return
    root=Path(root).resolve();bundle=json.loads((root/'bundle.json').read_text())
    record=bundle.get('calibration')
    if record is None:return
    from calibration import read_profile
    path=(root/record['path']).resolve()
    if not path.is_relative_to(root):raise ValueError('Calibration path must remain inside asset bundle')
    profile=read_profile(path)
    selected=profile['materials'].get(VARIANT or 'generic',{})
    for name,settings in selected.items():
        material=slots[name];node=material.node_tree.nodes.get('Principled BSDF')
        material.diffuse_color=(*settings['linear_rgb'],1.)
        node.inputs['Base Color'].default_value=(*settings['linear_rgb'],1.)
        node.inputs['Roughness'].default_value=settings['roughness']
        node.inputs['Metallic'].default_value=settings['metallic']
    MATERIAL_CALIBRATION={'profile_title':profile['title'],'source':profile['source'],'slots':selected,
        'scope':'Procedural linear RGB/roughness/metallic central values; other shader parameters remain modeled. Evidence dates do not verify the aircraft on the trip date.'}


def mesh(name, vertices, faces, mat, smooth=False):
    data = bpy.data.meshes.new(name)
    data.from_pydata(vertices, [], faces)
    data.update()
    ob = bpy.data.objects.new(name, data)
    bpy.context.collection.objects.link(ob)
    ob.data.materials.append(mat)
    ob.parent = aircraft
    if smooth:
        for poly in data.polygons:
            poly.use_smooth = True
    return ob


def tube(name, stations, mat, segments=48, caps=True):
    """Rounded closed elliptical fuselage/nacelle, stations y/xr/zr/zcenter."""
    vertices = []
    for y, rx, rz, zc in stations:
        for j in range(segments):
            a = 2 * math.pi * j / segments
            vertices.append((rx * math.cos(a), y, zc + rz * math.sin(a)))
    faces = []
    for i in range(len(stations)-1):
        for j in range(segments):
            faces.append((i*segments+j, i*segments+(j+1)%segments,
                          (i+1)*segments+(j+1)%segments, (i+1)*segments+j))
    if caps:
        faces.append(tuple(range(segments-1,-1,-1)))
        faces.append(tuple((len(stations)-1)*segments+j for j in range(segments)))
    ob = mesh(name, vertices, faces, mat, True)
    sub = ob.modifiers.new('Smooth aerodynamic surface', 'SUBSURF')
    sub.levels = sub.render_levels = 2
    return ob


def chevron_cowl(name, mat):
    """Small modeled fan-cowl teeth, with a closed thin rear edge.

    Boeing/NASA document chevrons on the 787 nacelle. These twelve stylized
    teeth establish that feature without claiming a particular engine drawing.
    They are surface geometry, so the itinerary Sun gives them real shadows.
    """
    segments=24
    vertices=[]
    for ring in range(4):
        for j in range(segments):
            angle=2*math.pi*j/segments
            front=ring in (0,3)
            inner=ring in (2,3)
            radius=(.36 if front else .335)-(.012 if inner else 0)
            y=-.86 if front else (-1.08 if j%2==0 else -.94)
            vertices.append((radius*math.cos(angle),y,-.44+radius*math.sin(angle)))
    faces=[]
    for ring in range(4):
        next_ring=(ring+1)%4
        for j in range(segments):
            k=(j+1)%segments
            faces.append((ring*segments+j,ring*segments+k,
                          next_ring*segments+k,next_ring*segments+j))
    return mesh(name,vertices,faces,mat,True)


def wing(name, points, thick, mat):
    """Closed thin swept aerofoil; the spanwise z values form dihedral."""
    n = len(points)
    verts = [(x,y,z+thick/2) for x,y,z in points]
    verts += [(x,y,z-thick/2) for x,y,z in points]
    faces = [tuple(range(n)), tuple(range(2*n-1,n-1,-1))]
    faces += [(i,(i+1)%n,(i+1)%n+n,i+n) for i in range(n)]
    ob = mesh(name, verts, faces, mat)
    bevel = ob.modifiers.new('Rounded aerodynamic edges', 'BEVEL')
    bevel.width = min(.06, thick*.33)
    bevel.segments = 3
    normal = ob.modifiers.new('Weighted normals', 'WEIGHTED_NORMAL')
    normal.keep_sharp = True
    return ob


def seam(name, coords, radius=.009, mat=None):
    data = bpy.data.curves.new(name, 'CURVE')
    data.dimensions = '3D'
    data.bevel_depth = radius
    data.bevel_resolution = 2
    s = data.splines.new('POLY')
    s.points.add(len(coords)-1)
    for p, xyz in zip(s.points,coords):
        p.co = (*xyz,1)
    ob = bpy.data.objects.new(name,data)
    bpy.context.collection.objects.link(ob)
    ob.parent = aircraft
    ob.data.materials.append(mat or panel)
    return ob


def cylinder(name, radius, depth, loc, mat, vertices=64):
    bpy.ops.mesh.primitive_cylinder_add(vertices=vertices, radius=radius,
                                       depth=depth, location=loc,
                                       rotation=(math.pi/2,0,0))
    ob = bpy.context.object
    ob.name = name
    ob.parent = aircraft
    ob.data.materials.append(mat)
    for f in ob.data.polygons:
        f.use_smooth = True
    b = ob.modifiers.new('Machined lip bevel', 'BEVEL')
    b.width=.02
    b.segments=3
    return ob


def create_procedural_aircraft():
    global panel, BEACON
    paint = material('Pearl white aircraft paint',(.80,.82,.84),.16,.30)
    wings = material('Warm silver composite wing',(.53,.58,.63),.34,.34)
    metal = material('Polished intake and leading edges',(.42,.48,.56),.82,.23)
    glass = material('Smoked blue cockpit glazing',(.018,.050,.074),.40,.17)
    dark = material('Engine interiors',(.009,.014,.019),.2,.52)
    panel = material('Subtle control surface joints',(.16,.20,.24),.25,.45)
    if CINEMATIC:
        p=paint.node_tree.nodes.get('Principled BSDF')
        p.inputs['Metallic'].default_value=.025
        p.inputs['Roughness'].default_value=.26
        p.inputs['Coat Weight'].default_value=.38
        p.inputs['Coat Roughness'].default_value=.16
        p=glass.node_tree.nodes.get('Principled BSDF')
        p.inputs['Metallic'].default_value=0
        p.inputs['Roughness'].default_value=.085
        p.inputs['IOR'].default_value=1.5
        p.inputs['Transmission Weight'].default_value=.05
        p.inputs['Coat Weight'].default_value=.35
    apply_material_calibration({'paint':paint,'wing':wings,'metal':metal,'glass':glass,'dark':dark,'panel':panel})
    tube('Rounded pressure fuselage',[
        (-6.25,.018,.018,.19),(-5.85,.16,.17,.10),(-5.0,.35,.36,0),
        (-4.1,.52,.54,0),(-3.2,.59,.61,0),(2.95,.59,.61,0),
        (4.15,.54,.55,-.015),(4.8,.43,.43,-.04),(5.35,.28,.29,-.075),
        (5.68,.08,.10,-.11),(5.76,.015,.018,-.12)],paint)
    for sign,side in ((-1,'port'),(1,'starboard')):
        wing(side+' swept main wing',[
            (sign*.40,1.00,.02),(sign*1.7,.28,.11),
            (sign*5.65,-2.05,.43),(sign*5.78,-2.68,.47),
            (sign*5.25,-2.75,.42),(sign*2.00,-1.71,.13),
            (sign*.40,-1.59,.02)],.12,wings)
        wing(side+' blended winglet',[
            (sign*5.63,-2.05,.43),(sign*5.86,-2.25,1.0),
            (sign*5.91,-2.69,.98),(sign*5.77,-2.69,.47)],.055,paint)
        wing(side+' horizontal tailplane',[
            (sign*.30,-4.33,.28),(sign*2.35,-5.39,.43),
            (sign*2.42,-5.89,.46),(sign*.22,-5.63,.28)],.10,wings)
        # The engine nacelles and lips are entirely modeled, including the
        # recessed fan cavity. The overhead view shows forward nacelle cowling.
        rear_stations=([(-.88,.36,.36,-.44),(-.84,.365,.365,-.44)]
                       if VARIANT=='787-9' else
                       [(-1.08,.25,.25,-.44),(-.88,.36,.36,-.44)])
        engine = tube(side+' rounded engine nacelle',rear_stations+[
            (.25,.41,.41,-.44),(.86,.39,.39,-.44),
            (1.02,.35,.35,-.44),(1.025,.32,.32,-.44),
            (.72,.30,.30,-.44)],paint,caps=False)
        engine.location.x=sign*1.93
        if VARIANT=='787-9':
            chevrons=chevron_cowl(side+' nacelle chevron fan cowl',paint)
            chevrons.location.x=sign*1.93
        # A separate inner shell/rim leaves a real recessed dark intake.
        lip=tube(side+' metal intake rim',[
            (.90,.357,.357,-.44),(1.035,.355,.355,-.44),
            (1.055,.321,.321,-.44),(.90,.315,.315,-.44)],metal,caps=False)
        lip.location.x=sign*1.93
        cylinder(side+' recessed fan disc',.302,.024,(sign*1.93,.87,-.44),dark)
        if CINEMATIC:
            # Concentric blade-average rings are a stable representation of a
            # rotating fan's exposure, avoiding blade aliasing in an 18s film.
            fan=material(side+' motion-averaged titanium fan',(.065,.085,.105),.65,.48)
            for rr in (.11,.17,.23,.285):
                bpy.ops.mesh.primitive_torus_add(major_radius=rr,minor_radius=.012,
                    major_segments=48,minor_segments=8,location=(sign*1.93,.888,-.44),
                    rotation=(math.pi/2,0,0))
                rotor=bpy.context.object;rotor.name=side+' blurred fan band'
                rotor.parent=aircraft;rotor.data.materials.append(fan)
            bpy.ops.mesh.primitive_cone_add(vertices=32,radius1=.09,radius2=.013,
                depth=.18,location=(sign*1.93,.948,-.44),rotation=(-math.pi/2,0,0))
            spinner=bpy.context.object;spinner.name=side+' fan spinner'
            spinner.parent=aircraft;spinner.data.materials.append(metal)
            for face in spinner.data.polygons: face.use_smooth=True
        cylinder(side+' exhaust core',.20,.14,(sign*1.93,-1.10,-.44),metal)
        wing(side+' engine pylon',[(sign*1.82,.6,-.20),
            (sign*2.04,.55,-.20),(sign*2.04,-.9,.1),
            (sign*1.82,-.9,.1)],.15,paint)
        seam(side+' flap hinge',[(sign*.65,-1.25,.102),
            (sign*2.0,-1.35,.214),(sign*4.9,-2.35,.455)],.008)
        seam(side+' aileron division',[(sign*4.05,-2.06,.398),
            (sign*4.11,-2.48,.398)],.008)
        seam(side+' tail elevator hinge',[(sign*.7,-5.5,.355),
            (sign*2.25,-5.76,.503)],.007)
        seam(side+' wing leading edge',[(sign*.65,.96,.09),
            (sign*1.7,.30,.18),(sign*5.60,-2.02,.50)],.022,metal)
        if CINEMATIC:
            color=(.9,.008,.003) if sign<0 else (.006,.75,.08)
            nav,_=lamp(side+' position light',(sign*5.82,-2.30,1.015),color,.070,5.0)
            FLEX_LAMPS.append((nav,nav.location.copy()))
    # Tall vertical fin: top view retains its real shadow across the tailplane.
    fin = wing('Vertical tail fin',[
        (-.06,-3.95,.48),(-.05,-5.31,2.30),
        (-.05,-5.92,2.35),(-.06,-5.85,.20)],.12,paint)
    # wing() extrudes in Z, so construct the fin with transverse thickness.
    bpy.data.objects.remove(fin,do_unlink=True)
    poly=[(-3.95,.48),(-5.31,2.30),(-5.92,2.35),(-5.85,.20)]
    verts=[(x,y,z) for x in (-.075,.075) for y,z in poly]
    f=mesh('Vertical tail fin',verts,[(0,1,2,3),(7,6,5,4),
        (0,4,5,1),(1,5,6,2),(2,6,7,3),(3,7,4,0)],paint)
    b=f.modifiers.new('Rounded tail edges','BEVEL');b.width=.035;b.segments=3
    f.modifiers.new('Tail weighted normals','WEIGHTED_NORMAL')
    # Four separated windscreen panels conform to the upper curved nose.
    for sign in (-1,1):
        mesh('Forward cockpit windscreen',[
            (sign*.027,4.74,.434),(sign*.22,4.69,.404),
            (sign*.26,5.02,.283),(sign*.027,5.12,.310)],[(0,1,2,3)],glass)
        mesh('Side cockpit glazing',[
            (sign*.25,4.69,.395),(sign*.38,4.48,.326),
            (sign*.385,4.82,.218),(sign*.28,5.01,.274)],[(0,1,2,3)],glass)
        if VARIANT and VARIANT!='787-9':
            mesh('Rear side cockpit glazing',[
                (sign*.405,4.46,.300),(sign*.45,4.30,.263),
                (sign*.47,4.56,.155),(sign*.405,4.79,.210)],[(0,1,2,3)],glass)
    if CINEMATIC:
        lamp('White aft position light',(0,-5.94,.35),(.8,.86,1.0),.055,3.0)
        _,BEACON=lamp('Red upper anti-collision beacon',(0,-.55,.625),(.95,.006,.002),.056,.15)
        if VARIANT: adapt_airframe(VARIANT)
        prepare_flex()


def create_scene():
    global aircraft, panel, BEACON, MOON, MATERIAL_CALIBRATION
    FLEX_OBJECTS.clear();FLEX_LAMPS.clear();MATERIAL_CALIBRATION={}
    bpy.ops.object.select_all(action='SELECT')
    bpy.ops.object.delete(use_global=False)
    scene = bpy.context.scene
    scene.render.engine = 'CYCLES'
    scene.cycles.samples = get_quality().aircraft_samples
    scene.cycles.use_denoising = True
    scene.cycles.max_bounces = 5
    scene.cycles.diffuse_bounces = 2
    scene.cycles.glossy_bounces = 3
    scene.render.threads_mode = 'FIXED'
    scene.render.threads = 6
    scene.render.resolution_x = scene.render.resolution_y = 384
    scene.render.resolution_percentage = 100
    scene.render.film_transparent = True
    scene.render.use_persistent_data = True
    scene.render.image_settings.file_format = 'PNG'
    scene.render.image_settings.color_mode = 'RGBA'
    scene.render.image_settings.color_depth = '8'
    # PNGs are review previews only. Compositor EXRs bypass this display view.
    scene.view_settings.view_transform = 'AgX'
    scene.view_settings.look = 'None'
    scene.view_settings.exposure = 0.
    scene.view_layers[0].use_pass_z = True
    scene.world.use_nodes = True
    bg = scene.world.node_tree.nodes.get('Background')
    # Uniform low blue earth/sky fill keeps an eclipse readable. It has no fixed
    # highlight direction and is deliberately dimmer than direct sunlight.
    bg.inputs['Color'].default_value = (.01,.018,.03,1)
    bg.inputs['Strength'].default_value = 1.
    if CINEMATIC: cinematic_environment(scene)

    aircraft = bpy.data.objects.new('Generic twin-engine airliner',None)
    bpy.context.collection.objects.link(aircraft)
    if ASSET_MODEL is not None:
        import_aircraft_model()
    else:
        create_procedural_aircraft()

    # A 384px cache samples the same angles as the final 224px central crop.
    focal=1080/(2*math.tan(math.radians(35)))
    model_camera_distance=16.4*focal/224
    bpy.ops.object.camera_add(location=(0,0,model_camera_distance))
    camera=bpy.context.object
    camera.name='Shared finite perspective aircraft crop'
    camera.rotation_euler=(0,0,0)
    camera.data.type='PERSP'
    camera.data.sensor_fit='HORIZONTAL'
    camera.data.sensor_width=32.
    camera.data.lens=32.*focal/224
    camera.data.clip_start=.01
    camera.data.clip_end=200.
    scene.camera=camera
    bpy.ops.object.light_add(type='SUN',location=(0,0,10))
    sun=bpy.context.object
    sun.name='Astronomical sun (from itinerary)'
    sun.data.angle=math.radians(.53)
    sun.data.energy=math.pi
    sun.data.use_shadow=True
    bpy.ops.object.light_add(type='SUN',location=(0,0,10))
    MOON=bpy.context.object
    MOON.name='Astronomical moon (from shared incoming radiance)'
    MOON.data.angle=math.radians(.52)
    MOON.data.energy=0.
    MOON.data.use_shadow=True
    return scene,sun


def lunar_light_state(sample):
    """Hashable, validated shared Moon state; no per-aircraft color invention."""
    enabled=sample.get('moonlight_enabled',False)
    if not isinstance(enabled,bool):
        raise ValueError('moonlight_enabled must be boolean')
    if not enabled:
        return (False,(0.,0.,1.),(0.,0.,0.),math.radians(.52))
    direction=np.asarray(sample.get('moon_camera'),dtype=np.float64)
    rgb=np.asarray(sample.get('moon_rgb'),dtype=np.float64)
    angle=float(sample.get('moon_angular_diameter',0.))
    if (direction.shape!=(3,) or not np.isfinite(direction).all() or
            not np.isclose(np.linalg.norm(direction),1.,atol=1e-5) or
            rgb.shape!=(3,) or not np.isfinite(rgb).all() or np.any(rgb<0) or
            not math.isfinite(angle) or not 0<angle<math.pi):
        raise ValueError('Moon samples need unit direction, finite nonnegative RGB and angular diameter in radians')
    return (True,tuple(direction),tuple(rgb),angle)


def solar_light_state(sample):
    """Additional shared spectral attenuation; separate from Earth visibility."""
    rgb=np.asarray(sample.get('sun_rgb',(1.,1.,1.)),dtype=np.float64)
    if rgb.shape!=(3,) or not np.isfinite(rgb).all() or np.any(rgb<0) or np.any(rgb>1):
        raise ValueError('sun_rgb must contain three finite nonnegative linear multipliers at most one')
    return tuple(float(v) for v in rgb)


def attitude_state(sample):
    """Validated local modeled pose: right wing down and nose up are positive."""
    values=(sample.get('bank_deg',0.),sample.get('pitch_deg',0.))
    if any(isinstance(value,(bool,np.bool_)) or not isinstance(value,(int,float,np.number))
           or not math.isfinite(float(value)) or abs(float(value))>=90 for value in values):
        raise ValueError('Aircraft bank/pitch must be finite degree angles strictly between -90 and 90')
    return tuple(float(value) for value in values)


def pose(sample, sun):
    bank,pitch=attitude_state(sample)
    # Local axes: +X starboard, +Y nose, +Z up. Roll about the forward
    # axis, then pitch, then yaw into geographic east/north. The same rigid
    # transform reaches Cycles radiance, self-shadow, Z and contact bounds.
    rotation=(Matrix.Rotation(-math.radians(sample['heading']),4,'Z')
              @ Matrix.Rotation(math.radians(pitch),4,'X')
              @ Matrix.Rotation(math.radians(bank),4,'Y'))
    aircraft.rotation_mode='QUATERNION'
    aircraft.rotation_quaternion=rotation.to_quaternion()
    direction=Vector(sample['sun_camera'])
    # A SUN's local -Z points along its rays, away from the sun.
    sun.rotation_euler=(-direction).to_track_quat('-Z','Y').to_euler()
    sun.data.energy=math.pi*sample['sun_visibility']
    sun.data.color=tuple(base*factor for base,factor in zip(SUN_COLOR,solar_light_state(sample)))
    enabled,moon_direction,moon_rgb,angle=lunar_light_state(sample)
    peak=max(moon_rgb)
    MOON.rotation_euler=(-Vector(moon_direction)).to_track_quat('-Z','Y').to_euler()
    MOON.data.angle=angle
    MOON.data.color=tuple(value/peak for value in moon_rgb) if peak else (1.,1.,1.)
    MOON.data.energy=math.pi*peak
    if CINEMATIC:
        update_environment(sample)
        detail=None if ASSET_MODEL is not None else update_flex(sample)
    else:
        daylight=float(np.clip((sample['sun_camera'][2]+.10)/.45,0,1))
        bpy.context.scene.world.node_tree.nodes.get('Background').inputs['Strength'].default_value=(
            .20+.80*daylight if enabled else 1.)
        detail=None
    bpy.context.view_layer.update()
    return detail


def validate_geometry(scene, sun):
    """Check source dimensions and pose/flex without producing any frames."""
    if ASSET_MODEL is not None:
        for heading in (0, 90, 225, 0):
            pose({'heading': heading, 'sun_camera': [.36,-.48,.8], 'sun_visibility': 1.}, sun)
        return {'variant': VARIANT, 'imported_geometry': ASSET_GEOMETRY,
                'asset_sha256': ASSET_METADATA['sha256'], 'frames_rendered': 0}
    if VARIANT is None:
        raise ValueError('--validate-only requires an aircraft type')
    spec=AIRFRAME_SPECS[VARIANT]
    unit=spec['length_m']/12.01

    def vertices(names):
        points=[]
        for ob in aircraft.children:
            if ob.type=='MESH' and any(name in ob.name for name in names):
                points.extend(tuple(ob.matrix_local@v.co) for v in ob.data.vertices)
        return np.asarray(points)

    body=vertices(['Rounded pressure fuselage'])
    wings=vertices(['swept main wing','winglet'])
    tail=vertices(['horizontal tailplane'])
    measured={
        'fuselage_length_m':float(np.ptp(body[:,1])*unit),
        'fuselage_width_m':float(np.ptp(body[:,0])*unit),
        'wing_span_m':float(np.ptp(wings[:,0])*unit),
        'tailplane_span_m':float(np.ptp(tail[:,0])*unit),
        'fuselage_midpoint_model_units':float((body[:,1].min()+body[:,1].max())/2),
    }
    for measured_name,spec_name in [('fuselage_length_m','length_m'),
                                    ('fuselage_width_m','fuselage_width_m'),
                                    ('wing_span_m','span_m'),
                                    ('tailplane_span_m','tailplane_span_m')]:
        assert abs(measured[measured_name]-spec[spec_name])<1e-4, (measured_name,measured)
    assert abs(measured['fuselage_midpoint_model_units'])<1e-6
    names=[ob.name for ob in aircraft.children]
    if VARIANT=='787-9':
        assert not any('winglet' in name for name in names)
        assert sum('chevron fan cowl' in name for name in names)==2
        assert sum('cockpit' in name for name in names)==4
    if VARIANT=='757-300':
        assert sum('conventional blended winglet' in name for name in names)==2
        assert not any('chevron' in name for name in names)
    # Exercise the actual lighting and flex path, then restore a neutral pose.
    for heading,altitude in [(0,0),(120,11000),(290,6000),(0,0)]:
        sample={'heading':heading,'illustrative_altitude_m':altitude,
                'sun_camera':[.36,-.48,.8],'sun_visibility':1.0,'t':0.0}
        pose(sample,sun)
        assert np.isfinite(vertices(['swept main wing','nacelle','winglet'])).all()
    assert scene.render.engine=='CYCLES' and scene.render.film_transparent
    return {'variant':VARIANT,'control_mesh_dimensions':measured,
            'dimension_tolerance_m':1e-4,'pose_flex_lighting':'passed',
            'frames_rendered':0}


def linear_output_nodes(scene, directory):
    """Write raw floating-point Combined and Z passes on Blender 4 or 5."""
    if hasattr(scene,'compositing_node_group'):
        tree=bpy.data.node_groups.new('Linear aircraft export','CompositorNodeTree')
        scene.compositing_node_group=tree
        tree.interface.new_socket(name='Image',in_out='OUTPUT',socket_type='NodeSocketColor')
        output=tree.nodes.new('NodeGroupOutput')
    else:
        scene.use_nodes=True
        tree=scene.node_tree
        tree.nodes.clear()
        output=tree.nodes.new('CompositorNodeComposite')
    render=tree.nodes.new('CompositorNodeRLayers')
    tree.links.new(render.outputs['Image'],output.inputs['Image'])
    for name,socket in [('radiance','Image'),('depth','Depth')]:
        node=tree.nodes.new('CompositorNodeOutputFile')
        if hasattr(node.format,'media_type'):
            node.format.media_type='IMAGE'
        node.format.file_format='OPEN_EXR'
        node.format.color_mode='RGBA'
        node.format.color_depth='32'
        if hasattr(node,'file_output_items'):
            node.directory=str(directory)
            node.file_name=name
            node.save_as_render=False
            node.file_output_items.new('RGBA','Image')
        else:
            node.base_path=str(directory)
            node.file_slots[0].path=name
            node.file_slots[0].save_as_render=False
        tree.links.new(render.outputs[socket],node.inputs[0])
    return tree


def physical_model_clearance(root, metres_per_unit):
    """Seat the lowest evaluated aircraft mesh above its local terrain anchor."""
    graph = bpy.context.evaluated_depsgraph_get()
    lowest = 0.
    for obj in (root, *root.children_recursive):
        if obj.type != 'MESH' or obj.hide_render:
            continue
        evaluated = obj.evaluated_get(graph)
        mesh = evaluated.to_mesh()
        try:
            if mesh is not None and len(mesh.vertices):
                vertices = np.empty(len(mesh.vertices)*3,np.float32)
                mesh.vertices.foreach_get('co',vertices)
                matrix = np.asarray(evaluated.matrix_world,dtype=np.float64)
                world_z = vertices.reshape(-1,3) @ matrix[2,:3] + matrix[2,3]
                lowest = min(lowest,float(world_z.min()))
        finally:
            evaluated.to_mesh_clear()
    return -lowest * metres_per_unit


def export_linear_passes(directory, destination, sample, scene):
    """Map Cycles surface depth into normalized globe-camera ray distance.

    The lateral apparent size is intentionally enlarged for playback. Surface
    height offsets retain manufacturer metres and the globe's vertical scale;
    this keeps cloud crossings tied to aircraft altitude rather than icon size.
    """
    def read_pass(name):
        paths=sorted(directory.glob(name+'*.exr'))
        if len(paths)!=1:
            raise RuntimeError(f'Expected one {name} EXR, found {paths}')
        image=bpy.data.images.load(str(paths[0]),check_existing=False)
        width,height=image.size
        data=np.empty(width*height*4,np.float32)
        image.pixels.foreach_get(data)
        bpy.data.images.remove(image)
        return data.reshape(height,width,4)[::-1].copy()
    rgba=read_pass('radiance')
    z=read_pass('depth')[...,0]
    alpha=np.clip(rgba[...,3:],0,1)
    # Cycles denoising can spread color beyond zero coverage. Keep the source
    # strictly premultiplied so invisible pixels cannot add a screen-space halo.
    light=np.where(alpha>0,np.maximum(rgba[...,:3],0),0)
    h,w=z.shape
    yy,xx=np.mgrid[:h,:w]
    focal=1080/(2*math.tan(math.radians(35)))*(w/224)
    ray_z=1/np.sqrt(1+((xx+.5-w/2)/focal)**2+((yy+.5-h/2)/focal)**2)
    covered=alpha[...,0]>0
    valid_z=np.isfinite(z)&(z>0)&(z<1e8)
    # Cycles Z is axial camera-space depth, not normalized-ray distance.
    # Convert its surface height first, then divide Earth-space axial depth by
    # the shared ray cosine below. The planar Blender regression checks this.
    model_height=np.where(valid_z,float(scene.camera.location.z)-z,0)
    metres_per_unit=(ASSET_METADATA['length_m']/12.01 if ASSET_MODEL is not None else
                     AIRFRAME_SPECS[VARIANT]['length_m']/12.01 if VARIANT else 63.73/12.01)
    camera_distance=float(sample['camera_distance_earth'])
    altitude=float(sample.get('rendered_altitude_m',sample['aircraft_altitude_m']))
    height_scale=float(sample.get('vertical_exaggeration',1.))
    clearance=physical_model_clearance(aircraft,metres_per_unit)
    depth=(camera_distance-1-(altitude+(model_height*metres_per_unit+clearance)*height_scale)/6371000)/ray_z
    depth=np.where(covered,depth,np.inf).astype(np.float32)
    # The Z pass is intentionally unfiltered; a coverage edge can have no
    # center-ray hit. Those pixels use the shared aircraft anchor depth.
    if np.any(depth[covered]<=0) or not np.isfinite(light).all():
        raise RuntimeError('Invalid aircraft radiance or Earth-camera depth.')
    temporary=destination.with_suffix('.tmp.npz')
    bank,pitch=attitude_state(sample)
    np.savez_compressed(temporary,schema_version=np.int32(2),radiance=light,
                        alpha=alpha.astype(np.float32),depth=depth,
                        camera_distance_earth=np.float64(camera_distance),
                        rendered_altitude_m=np.float64(altitude),
                        model_camera_height_m=np.float64(scene.camera.location.z*metres_per_unit),
                        ground_clearance_m=np.float64(clearance),
                        bank_deg=np.float64(bank),pitch_deg=np.float64(pitch))
    temporary.replace(destination)


def validate_depth_export():
    """Render a known plane to verify Blender Z convention and NPZ conversion.

    This is a real renderer fixture, so a Blender version changing its Z-pass
    convention fails before a renderer update can silently corrupt cloud depth.
    """
    global aircraft
    bpy.ops.object.select_all(action='SELECT')
    bpy.ops.object.delete(use_global=False)
    scene=bpy.context.scene
    scene.render.engine='CYCLES'
    scene.cycles.samples=1
    scene.cycles.use_denoising=False
    scene.render.resolution_x=scene.render.resolution_y=64
    scene.render.resolution_percentage=100
    scene.render.film_transparent=True
    scene.view_layers[0].use_pass_z=True
    aircraft=bpy.data.objects.new('Depth fixture aircraft root',None)
    scene.collection.objects.link(aircraft)
    plane_height=1.25
    camera_height=10.
    bpy.ops.mesh.primitive_plane_add(size=100,location=(0,0,plane_height))
    fixture_plane=bpy.context.object
    fixture_plane.parent=aircraft
    focal=1080/(2*math.tan(math.radians(35)))
    bpy.ops.object.camera_add(location=(0,0,camera_height))
    camera=bpy.context.object
    camera.rotation_euler=(0,0,0)
    camera.data.type='PERSP'
    camera.data.sensor_fit='HORIZONTAL'
    camera.data.sensor_width=32.
    camera.data.lens=32.*focal/224
    camera.data.clip_end=200.
    scene.camera=camera
    sample={'camera_distance_earth':1.95,'aircraft_altitude_m':11000.,
            'rendered_altitude_m':132000.,'vertical_exaggeration':12.}
    with tempfile.TemporaryDirectory(prefix='depth-fixture-',dir=ASSETS) as temporary:
        directory=Path(temporary)
        linear_output_nodes(scene,directory)
        bpy.ops.render.render(write_still=False)
        image=bpy.data.images.load(str(next(directory.glob('depth*.exr'))),check_existing=False)
        pixels=np.empty(64*64*4,np.float32)
        image.pixels.foreach_get(pixels)
        bpy.data.images.remove(image)
        z=pixels.reshape(64,64,4)[::-1,:,0]
        yy,xx=np.mgrid[:64,:64]
        ray_cos=1/np.sqrt(1+((xx+.5-32)/(focal*64/224))**2+((yy+.5-32)/(focal*64/224))**2)
        axial=camera_height-plane_height
        export_linear_passes(directory,directory/'fixture.npz',sample,scene)
        with np.load(directory/'fixture.npz') as layer:
            surface_radius=sample['camera_distance_earth']-layer['depth']*ray_cos
        metres_per_unit=AIRFRAME_SPECS[VARIANT]['length_m']/12.01 if VARIANT else 63.73/12.01
        expected_radius=1+(sample['rendered_altitude_m']+plane_height*metres_per_unit*12)/6371000
        result={
            'blender_version':bpy.app.version_string,
            'fixture':'Plane z=1.25, camera z=10, shared finite perspective crop',
            'z_convention':'axial_camera_depth',
            'samples':[{'pixel':[x,y],'z':float(z[y,x]),'axial_expected':axial,
                        'ray_distance_if_that_convention':float(axial/ray_cos[y,x])}
                       for x,y in [(32,32),(1,1),(62,32),(32,62)]],
            'max_axial_error':float(np.max(np.abs(z-axial))),
            'max_export_surface_radius_error_earth':float(np.max(np.abs(surface_radius-expected_radius))),
        }
        # A second real render puts the entire mesh below its anchor. Its
        # contact correction must seat that lowest surface exactly on ground.
        fixture_plane.location.z=-plane_height
        bpy.context.view_layer.update()
        bpy.ops.render.render(write_still=False)
        export_linear_passes(directory,directory/'contact.npz',sample,scene)
        with np.load(directory/'contact.npz') as layer:
            surface_radius=sample['camera_distance_earth']-layer['depth']*ray_cos
            result['contact_clearance_m']=float(layer['ground_clearance_m'])
        result['contact_clearance_expected_m']=plane_height*metres_per_unit
        expected_contact_radius=1+sample['rendered_altitude_m']/6371000
        result['max_contact_radius_error_earth']=float(np.max(np.abs(surface_radius-expected_contact_radius)))
    # A tilted triangle has empty bounding-box corners below every actual
    # vertex. Nested aircraft geometry counts; unrelated scene meshes do not.
    fixture_plane.hide_render=True
    mesh=bpy.data.meshes.new('Rotated contact triangle')
    mesh.from_pydata([(0,0,0),(2,0,2),(0,1,0)],[],[(0,1,2)])
    triangle=bpy.data.objects.new('Rotated contact triangle',mesh)
    scene.collection.objects.link(triangle)
    parent=bpy.data.objects.new('Nested fixture assembly',None)
    scene.collection.objects.link(parent)
    parent.parent=aircraft
    triangle.parent=parent
    triangle.rotation_euler.y=math.radians(45)
    triangle.location.z=-1.
    solidify=triangle.modifiers.new('Evaluated contact thickness','SOLIDIFY')
    solidify.thickness=.25
    solidify.offset=-1.
    bpy.ops.mesh.primitive_plane_add(size=100,location=(0,0,-100))
    bpy.context.view_layer.update()
    # The original transformed triangle is horizontal at -1; solidify adds
    # exactly .25 downward. This also checks that modifiers are evaluated.
    actual_min=-1.25
    evaluated=triangle.evaluated_get(bpy.context.evaluated_depsgraph_get())
    box_min=min(float((evaluated.matrix_world @ Vector(corner)).z) for corner in evaluated.bound_box)
    result['rotated_contact']={
        'minimum_vertex_z':actual_min,'minimum_bound_box_z':box_min,
        'clearance_m':physical_model_clearance(aircraft,metres_per_unit),
        'expected_clearance_m':-actual_min*metres_per_unit,
        'unrelated_scene_mesh_z':-100.,
    }
    (ASSETS/'depth-validation.json').write_text(json.dumps(result,indent=2)+'\n')
    assert result['max_axial_error']<1e-5,result
    assert result['max_export_surface_radius_error_earth']<1e-7,result
    assert abs(result['contact_clearance_m']-result['contact_clearance_expected_m'])<1e-6,result
    assert result['max_contact_radius_error_earth']<1e-7,result
    assert box_min < actual_min-.5,result
    assert abs(result['rotated_contact']['clearance_m']-result['rotated_contact']['expected_clearance_m'])<1e-6,result
    return result


def main():
    global SPRITES, ASSET_MODEL, ASSET_METADATA
    parser=argparse.ArgumentParser()
    parser.add_argument('--preview',action='store_true')
    parser.add_argument('--all',action='store_true')
    parser.add_argument('--validate-only',action='store_true')
    parser.add_argument('--validate-depth-only',action='store_true')
    parser.add_argument('--cinematic',action='store_true')
    parser.add_argument('--asset-model',type=Path,help='Self-contained local GLB replacing the selected aircraft type')
    parser.add_argument('--asset-metadata',type=Path,help='JSON bundle record with immutable hash, dimensions, axes and source')
    variants=parser.add_mutually_exclusive_group()
    for name in AIRFRAME_SPECS:
        variants.add_argument('--'+name,action='store_true',dest=name.replace('-','_'))
    parser.add_argument('--start',type=int,default=0)
    parser.add_argument('--end',type=int)
    parser.add_argument('--threads',type=int,default=6)
    parser.add_argument('--flight-cycles-device',choices=('cpu','metal'),default='cpu')
    parser.add_argument('--device-record',type=Path,help='Expected device identity from the parent render probe')
    args=parser.parse_args(sys.argv[sys.argv.index('--')+1:] if '--' in sys.argv else [])
    if args.threads<1:
        parser.error('--threads must be positive')
    if bool(args.asset_model) != bool(args.asset_metadata) or (args.asset_model and VARIANT is None):
        parser.error('--asset-model and --asset-metadata require each other and a selected aircraft type')
    if args.asset_model and args.validate_depth_only:
        parser.error('--validate-depth-only is an independent camera fixture; omit asset arguments')
    if args.asset_model:
        from aircraft_assets import validate_aircraft_model
        ASSET_METADATA=json.loads(args.asset_metadata.read_text())
        if not isinstance(ASSET_METADATA,dict) or 'sha256' not in ASSET_METADATA:
            parser.error('Asset metadata requires the immutable GLB sha256')
        validate_aircraft_model(args.asset_model,ASSET_METADATA)
        ASSET_MODEL=args.asset_model
    if args.validate_depth_only:
        print(json.dumps(validate_depth_export(),indent=2),flush=True)
        return
    if args.validate_only:
        scene,sun=create_scene()
        print(json.dumps(validate_geometry(scene,sun),indent=2),flush=True)
        return
    samples=json.loads((ASSETS/'lighting-samples.json').read_text())
    available=[index for index,sample in enumerate(samples) if sample is not None]
    if not available:raise ValueError('No prepared aircraft lighting samples')
    if CINEMATIC:
        SPRITES=ASSETS/('frames-'+VARIANT if VARIANT else 'frames-cinematic')
        SPRITES.mkdir(exist_ok=True)
    scene,sun=create_scene()
    from cycles_device import select_device
    device_record=select_device(bpy,args.flight_cycles_device)
    if args.device_record and json.loads(args.device_record.read_text()) != device_record:
        raise RuntimeError('Cycles device changed since the render probe; restart with a new cache configuration.')
    scene.render.threads=args.threads
    pose(samples[available[0]],sun)
    if CINEMATIC: ENVIRONMENT.pack()
    blend_name=VARIANT+'.blend' if VARIANT else ('cinematic-airliner.blend' if CINEMATIC else 'generic-airliner.blend')
    bpy.ops.wm.save_as_mainfile(filepath=str(ASSETS/blend_name))
    indices=sorted(set([available[0],available[len(available)//2],available[-1]])) if args.preview else range(args.start,args.end if args.end is not None else len(samples))
    started=time.time()
    cache={}
    for index in indices:
        sample=samples[index]
        if sample is None:raise ValueError(f'Aircraft lighting frame {index} was not prepared')
        detail_state=pose(sample,sun)
        file=SPRITES/f'frame-{index:04d}.png'
        key=(sample['heading'], sample['sun_visibility'],solar_light_state(sample),
             attitude_state(sample),
             tuple(sample['sun_camera']) if (sample['sun_visibility'] or CINEMATIC or
                                             sample.get('moonlight_enabled',False)) else None,
             lunar_light_state(sample),
             detail_state,sample['camera_distance_earth'],
             sample.get('rendered_altitude_m',sample['aircraft_altitude_m']))
        if key in cache:
            shutil.copyfile(cache[key],file)
            shutil.copyfile(cache[key].with_suffix('.npz'),file.with_suffix('.npz'))
        else:
            scene.render.filepath=str(file)
            with tempfile.TemporaryDirectory(prefix='linear-aircraft-',dir=ASSETS) as temporary:
                tree=linear_output_nodes(scene,Path(temporary))
                bpy.ops.render.render(write_still=True)
                export_linear_passes(Path(temporary),file.with_suffix('.npz'),sample,scene)
                if hasattr(scene,'compositing_node_group'):
                    scene.compositing_node_group=None
                    bpy.data.node_groups.remove(tree)
            cache[key]=file
        print(f'AIRCRAFT {index} rendered; elapsed {time.time()-started:.1f}s',flush=True)
    metadata={
        'model':'Procedural generic twin-engine swept-wing airliner; no exact aircraft type claimed.',
        'script':'aircraft_blender.py','blender_version':bpy.app.version_string,
        'renderer':f'Cycles path tracer, {get_quality().aircraft_samples} samples with denoising',
        'cycles_device':device_record,
        'canvas':[384,384], 'camera':'Finite perspective central crop, shared 70-degree full-canvas field of view; northward nose +Y, camera +Z.',
        'lighting':'Directional astronomical sun from lighting-samples.json, 0.53 degree solar disc; true mesh self-shadowing. Sun occlusion by Earth uses itinerary position and illustrative flight altitude. Uniform blue environment fill at strength 0.65 lifts exposure for night readability; no directional fill is added.',
        'heading':'Clockwise from screen north, applied as negative Z rotation.',
        'attitude':'Optional modeled local bank/pitch from physical-time route curvature/climb; +bank right wing down, +pitch nose up. Rz(-heading) @ Rx(pitch) @ Ry(bank) rotates the same geometry before shadows, depth and evaluated contact clearance. Not measured attitude.',
        'composition':'Use RGBA frames/frame-{frame:04d}.png centered in the video; designed for a 224x224 composite footprint.',
        'intentional_scale':'Aircraft is diagrammatically enlarged over Earth; no surface cast shadow.',
        'source':'Original procedural mesh generated for this flight visualization.',
        'frames':len(samples),
        'material_calibration':MATERIAL_CALIBRATION or None,
        'sun_rgb':'Optional shared linear spectral attenuation multipliers; independent of Earth visibility.',
    }
    if CINEMATIC:
        metadata.update({
            'composition':'Use RGBA frames-cinematic/frame-{frame:04d}.png centered in video at 224×224. Same anchor and apparent size as baseline.',
            'environment':'Analytic local Earth/sky HDR radiance, aligned to local vertical and solar elevation/azimuth; reflection approximation, not a photographic HDRI or additional forecast.',
            'details':'Steady port-red/starboard-green/aft-white position lamps; subdued red upper beacon on presentation time; open intakes with motion-averaged fan bands and spinners; dielectric paint clearcoat and reflective cockpit glazing.',
            'flex':'Symmetric 0.18-model-unit maximum wingtip flex driven by illustrative flight altitude, with 6% slow settling variation; cinematic load-inspired deformation, not measured turbulence.',
            'lighting':'Same astronomical directional Sun, Earth eclipse and 0.53-degree disc as baseline. Environment approximates Earth/sky fill with a deliberate night exposure floor; no camera-fixed studio highlights or globe drop shadow.',
            'aircraft_type_status':'Aircraft type supplied in trip configuration; assignment requires separate verification.',
        })
    if VARIANT:
        metadata.update({
            'model':AIRFRAME_SPECS[VARIANT]['name']+' procedural dimensioned illustration.',
            'manufacturer_dimensions':AIRFRAME_SPECS[VARIANT],
            'aircraft_type_status':AIRFRAME_SPECS[VARIANT]['equipment_evidence'],
            'composition':f'RGBA frames-{VARIANT}/frame-{{frame:04d}}.png, centered at 224×224; fuselage midpoint at origin. All types use the same 12.01-model-unit fuselage length, intentionally preserving apparent graphic size.',
            'geometry_scope':'Manufacturer planform proportions, fuselage width, tailplane span, engine lateral position and type-specific tips. Nacelle, cockpit, fin and control surfaces are simplified original meshes, not engineering CAD. No airline livery or registration text.',
            'engine_option':'Generic nacelle envelope for the confirmed aircraft family; exact installed engine variant is not asserted.',
            'rendered_frame_indices':list(indices),
            'render_threads':args.threads,
        })
    metadata.update({
        'linear_cache':'frame-XXXX.npz: scene-relative premultiplied linear RGB, coverage alpha, normalized-ray distance in Earth radii; infinity outside coverage.',
        'photometry':'Diffuse white in direct Sun approximately one; not calibrated radiance. PNGs are review previews only. Global scene exposure and tone mapping happen after compositing.',
        'depth_scale':'Apparent aircraft size is exaggerated laterally. Cycles Z surface offsets use manufacturer metres and the same vertical exaggeration as globe terrain/clouds.',
        'lighting':'Same astronomical Sun vector and physical-altitude Earth eclipse as terrain; pi irradiance gives unit Lambert diffuse white. Earth/sky environment is an explicit low radiance approximation.',
        'moon_lighting':'Shared topocentric Moon direction, variable angular diameter and pre-attenuated incoming linear RGB; directional mesh self-shadowing. Enabled samples retain twenty percent of the legacy night-only environment floor, including below the lunar horizon; daytime fill and Sun are unchanged.',
        'environment_updates':'Generated environment pixels and world nodes are explicitly refreshed per pose; persistent Cycles data must not retain an earlier solar state or night floor.',
        'composition':'Consume NPZ linear light/coverage/depth; PNG files are display previews and must never be composited into the HDR scene.',
    })
    if ASSET_MODEL is not None:
        for name in ('manufacturer_dimensions','engine_option'):
            metadata.pop(name,None)
        metadata.update({'model':'User-supplied static GLB aircraft; geometry/materials retained from the attributed source.',
                         'asset_record':ASSET_METADATA,'imported_geometry':ASSET_GEOMETRY,
                         'source':ASSET_METADATA['source'],
                         'details':'Imported PBR materials; authored cameras and lights excluded.',
                         'flex':'Static supplied geometry; no procedural deformation or added lamps.',
                         'geometry_scope':'Uniformly scaled, centered envelope with declared glTF nose/up axes; span/length ratio must agree within 5%.',
                         'depth_scale':'Declared physical length maps imported mesh height to metres; shared Earth-ray depth and vertical exaggeration.',
                         'aircraft_type_status':'User-selected replacement asset; supplied provenance does not verify airline, registration or exact assignment.'})
    source_name='source-'+VARIANT+'.json' if VARIANT else ('source-cinematic.json' if CINEMATIC else 'source.json')
    (ASSETS/source_name).write_text(json.dumps(metadata,indent=2)+'\n')


if __name__=='__main__':
    main()
