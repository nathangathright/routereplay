"""Bounded, attributed local survey and procedural-material calibration.

Evidence timestamps describe measurements, not validity on future trip dates.
Uncertainty is provenance; rendering uses the declared central values without
random perturbation. Validation needs only the standard library.
"""
from datetime import datetime
import json
import math
from pathlib import Path

MAX_BYTES=256*1024
TYPES={'generic','a321neo','777-200er','787-9','757-300'}
SLOTS={'paint','wing','metal','glass','dark','panel'}
SOURCE_KEYS={'url','credit','license_url','notes'}


def _source(value):
    if not isinstance(value,dict) or set(value)!=SOURCE_KEYS or any(not isinstance(v,str) or not v.strip() for v in value.values()):
        raise ValueError('Calibration source needs url, credit, license_url and notes')


def _number(value,name,low,high):
    if isinstance(value,bool) or not isinstance(value,(int,float)) or not math.isfinite(value) or not low<=value<=high:
        raise ValueError(f'{name} must be finite in [{low}, {high}]')
    return float(value)


def _text(value,name):
    if not isinstance(value,str) or not value.strip():raise ValueError(f'{name} must be a nonempty string')


def _instant(value):
    try:
        when=datetime.fromisoformat(value.replace('Z','+00:00'))
        if when.utcoffset() is None:raise ValueError()
    except (AttributeError,TypeError,ValueError) as exc:
        raise ValueError('observed_at requires an ISO timestamp with a UTC offset') from exc


def _vector(value,name):
    if not isinstance(value,list) or len(value)!=3:raise ValueError(f'{name} requires three linear RGB values')
    for v in value:_number(v,name,0,1)


def validate_profile(value):
    if not isinstance(value,dict) or set(value)!={'schema_version','title','source','surveys','materials'} or type(value['schema_version']) is not int or value['schema_version']!=1:
        raise ValueError('Calibration requires schema_version 1, title, source, surveys and materials')
    try:size=len(json.dumps(value,ensure_ascii=False,allow_nan=False).encode())
    except (TypeError,ValueError) as exc:raise ValueError('Calibration must contain finite JSON values') from exc
    if size>MAX_BYTES:raise ValueError('Calibration exceeds 256 KiB')
    _text(value['title'],'title');_source(value['source'])
    surveys=value['surveys'];materials=value['materials']
    if not isinstance(surveys,list) or len(surveys)>32:raise ValueError('Calibration permits at most 32 surveys')
    if not isinstance(materials,dict) or set(materials)-TYPES:raise ValueError('Calibration materials must name supported aircraft types')
    if not surveys and not materials:raise ValueError('Calibration must contain a survey or material override')
    identifiers=set()
    required={'id','lat','lon','radius_m','elevation_m','datum','basis','source','notes'}
    for survey in surveys:
        if not isinstance(survey,dict) or not required<=set(survey) or set(survey)-required-{'code','observed_at','uncertainty_m'}:
            raise ValueError('Survey fields differ from the calibration schema')
        _text(survey['id'],'survey id');_text(survey['notes'],'survey notes');_source(survey['source'])
        if survey['id'] in identifiers:raise ValueError('Survey IDs must be unique')
        identifiers.add(survey['id'])
        if 'code' in survey:_text(survey['code'],'survey airport code')
        for key,low,high in [('lat',-90,90),('lon',-180,180),('radius_m',25,5000),('elevation_m',0,9000)]:_number(survey[key],key,low,high)
        if survey['datum'] not in ('MSL','EGM96','EGM2008'):raise ValueError('Survey datum must be MSL, EGM96 or EGM2008; ellipsoidal heights need conversion before import')
        if survey['basis'] not in ('measured','modeled'):raise ValueError('Survey basis must be measured or modeled')
        if survey['basis']=='measured' and not {'observed_at','uncertainty_m'}<=set(survey):raise ValueError('Measured surveys require observed_at and uncertainty_m evidence')
        if 'observed_at' in survey:_instant(survey['observed_at'])
        if 'uncertainty_m' in survey:_number(survey['uncertainty_m'],'uncertainty_m',0,1000)
    # Independent flat controls cannot both be authoritative in an overlap.
    for i,a in enumerate(surveys):
        for b in surveys[i+1:]:
            la,lb=math.radians(a['lat']),math.radians(b['lat']);dl=math.radians(a['lon']-b['lon'])
            h=math.sin((la-lb)/2)**2+math.cos(la)*math.cos(lb)*math.sin(dl/2)**2
            distance=12742000*math.asin(math.sqrt(min(1,max(0,h))))
            if distance<a['radius_m']+b['radius_m']:raise ValueError('Survey footprints overlap; use smaller radii or one explicitly reconciled control')
    for aircraft,slots in materials.items():
        if not isinstance(slots,dict) or not slots or set(slots)-SLOTS:raise ValueError('Material slots must be paint, wing, metal, glass, dark or panel')
        for slot,material in slots.items():
            required={'linear_rgb','roughness','metallic','basis','source','notes'}
            if not isinstance(material,dict) or not required<=set(material) or set(material)-required-{'observed_at','uncertainty'}:raise ValueError('Material fields differ from calibration schema')
            _vector(material['linear_rgb'],'linear_rgb');_number(material['roughness'],'roughness',0,1);_number(material['metallic'],'metallic',0,1)
            _text(material['notes'],'material notes');_source(material['source'])
            if material['basis'] not in ('measured','modeled'):raise ValueError('Material basis must be measured or modeled')
            if material['basis']=='measured' and not {'observed_at','uncertainty'}<=set(material):raise ValueError('Measured materials require observed_at and uncertainty evidence')
            if 'observed_at' in material:_instant(material['observed_at'])
            if 'uncertainty' in material:
                uncertainty=material['uncertainty']
                if not isinstance(uncertainty,dict) or set(uncertainty)!={'linear_rgb','roughness','metallic','notes'}:raise ValueError('Material uncertainty needs absolute linear_rgb, roughness, metallic bounds and notes')
                _vector(uncertainty['linear_rgb'],'uncertainty linear_rgb');_number(uncertainty['roughness'],'uncertainty roughness',0,1);_number(uncertainty['metallic'],'uncertainty metallic',0,1);_text(uncertainty['notes'],'uncertainty notes')
    return value


def read_profile(path):
    with Path(path).open('rb') as handle:raw=handle.read(MAX_BYTES+1)
    if len(raw)>MAX_BYTES:raise ValueError('Calibration exceeds 256 KiB')
    return validate_profile(json.loads(raw))


def profile_summary(profile):
    return {'survey_count':len(profile['surveys']),'material_types':sorted(profile['materials']),
            'max_elevation_m':max([0.]+[s['elevation_m'] for s in profile['surveys']]),
            'survey_scope':'Measured or modeled point controls; flat cores and surrounding feathered terrain are modeled, not surveyed runway geometry.',
            'date_scope':'observed_at is evidence time only; reuse on another trip date does not assert current verification.',
            'uncertainty_scope':'Declared evidence only; central values render deterministically.'}


def apply_surveys(profile,points,height):
    """Apply the same spherical footprint to surface, normals and clearance."""
    if profile is None or not profile['surveys']:return height
    import numpy as np
    points=np.asarray(points,float);points=points/np.linalg.norm(points,axis=-1,keepdims=True)
    value=np.asarray(height,float).copy()
    for survey in profile['surveys']:
        lat,lon=math.radians(survey['lat']),math.radians(survey['lon'])
        center=np.array([math.cos(lat)*math.cos(lon),math.cos(lat)*math.sin(lon),math.sin(lat)])
        # Chord distance is stable for small footprints and across the dateline.
        chord=np.linalg.norm(points-center,axis=-1)
        distance=12742000*np.arcsin(np.clip(chord*.5,0,1))
        t=np.clip((1-distance/survey['radius_m'])*2,0,1);weight=t*t*(3-2*t)
        value=value*(1-weight)+survey['elevation_m']*weight
    return value
