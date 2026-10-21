"""Recorded waypoint validation and CSV/GPX/KML/IGC ingestion, using only local files.

Coordinates are WGS84 degrees, timestamps explicit-offset ISO8601, and altitude
is geometric metres above mean sea level. Unknown or pressure altitude must be
converted by the caller; this module never silently treats feet as metres.
"""
from dataclasses import dataclass
from datetime import datetime, timezone
import csv
import json
import math
from pathlib import Path
import re


@dataclass(frozen=True)
class Waypoint:
    time: datetime
    lat: float
    lon: float
    altitude_m: float

    def to_dict(self):
        return {'time': self.time.isoformat().replace('+00:00', 'Z'),
                'lat': self.lat, 'lon': self.lon, 'altitude_m': self.altitude_m}


@dataclass(frozen=True)
class Trajectory:
    source: str
    max_gap_s: float
    points: tuple[Waypoint, ...]

    def to_dict(self):
        return {'source': self.source, 'altitude_reference': 'MSL',
                'max_gap_s': self.max_gap_s,
                'points': [point.to_dict() for point in self.points]}

    def gaps(self, depart, arrive):
        intervals = []
        if self.points[0].time > depart:
            intervals.append((depart, self.points[0].time, 'before_first_observation'))
        for a, b in zip(self.points, self.points[1:]):
            if (b.time-a.time).total_seconds() > self.max_gap_s:
                intervals.append((a.time, b.time, 'observation_gap'))
        if self.points[-1].time < arrive:
            intervals.append((self.points[-1].time, arrive, 'after_last_observation'))
        return [{'start': a.isoformat(), 'end': b.isoformat(), 'reason': reason,
                 'fallback': 'spherical position and linear altitude interpolation'}
                for a,b,reason in intervals]


def parse_trajectory(record, depart, arrive):
    if not isinstance(record, dict) or set(record)-{'source','altitude_reference','max_gap_s','points'}:
        raise ValueError('trajectory must contain source, altitude_reference, max_gap_s and points only')
    if not isinstance(record.get('source'), str) or not record['source'].strip():
        raise ValueError('trajectory.source must describe the source and whether it is recorded or synthetic')
    if record.get('altitude_reference') != 'MSL':
        raise ValueError('trajectory.altitude_reference must be MSL; convert pressure altitude or feet explicitly')
    gap = record.get('max_gap_s', 300.)
    if isinstance(gap, bool) or not isinstance(gap, (int,float)) or not math.isfinite(gap) or gap <= 0:
        raise ValueError('trajectory.max_gap_s must be finite and positive')
    rows = record.get('points')
    if not isinstance(rows, list) or len(rows) < 2:
        raise ValueError('trajectory.points needs at least two timestamped observations')
    points = []
    for index, row in enumerate(rows):
        label = f'trajectory.points[{index}]'
        if not isinstance(row,dict) or set(row) != {'time','lat','lon','altitude_m'}:
            raise ValueError(f'{label} requires exactly time, lat, lon, altitude_m')
        if not isinstance(row['time'],str) or not re.search(r'(?:Z|[+-]\d{2}:\d{2})$',row['time']):
            raise ValueError(f'{label}.time needs an explicit UTC offset')
        try:
            when = datetime.fromisoformat(row['time'].replace('Z','+00:00'))
            if when.tzinfo is None:raise ValueError('Missing timestamp offset')
            when = when.astimezone(timezone.utc)
        except (ValueError,OverflowError) as exc:
            raise ValueError(f'{label}.time is invalid') from exc
        if not depart <= when <= arrive or (points and when <= points[-1].time):
            raise ValueError(f'{label}.time must increase strictly and lie within the flight')
        values = []
        for key, minimum, maximum in [('lat',-90,90),('lon',-180,180),('altitude_m',-500,25000)]:
            value=row[key]
            if isinstance(value,bool) or not isinstance(value,(int,float)) or not math.isfinite(value) or not minimum <= value <= maximum:
                raise ValueError(f'{label}.{key} must be finite in [{minimum}, {maximum}]')
            values.append(float(value))
        point = Waypoint(when,*values)
        if points and angular_distance(points[-1],point) > math.pi-1e-7:
            raise ValueError(f'{label} is antipodal to the previous observation; supply an intermediate point')
        points.append(point)
    return Trajectory(record['source'].strip(),float(gap),tuple(points))


def angular_distance(a,b):
    aa,bb=math.radians(a.lat),math.radians(b.lat)
    dl=math.radians(b.lon-a.lon)
    h=math.sin((bb-aa)/2)**2+math.cos(aa)*math.cos(bb)*math.sin(dl/2)**2
    return 2*math.atan2(math.sqrt(max(0,min(1,h))),math.sqrt(max(0,1-h)))


MAX_TRACK_BYTES = 32*1024*1024
MAX_TRACK_POINTS = 100000
GPX_NAMESPACES = ('http://www.topografix.com/GPX/1/0', 'http://www.topografix.com/GPX/1/1')
KML_NAMESPACE = 'http://www.opengis.net/kml/2.2'
GX_NAMESPACE = 'http://www.google.com/kml/ext/2.2'


def _track_text(path):
    path=Path(path)
    if not path.is_file() or path.stat().st_size>MAX_TRACK_BYTES:
        raise ValueError('Track must be a local UTF-8 file no larger than 32 MiB')
    with path.open('rb') as handle:raw=handle.read(MAX_TRACK_BYTES+1)
    if len(raw)>MAX_TRACK_BYTES:raise ValueError('Track exceeds 32 MiB')
    try:return raw.decode('utf-8-sig')
    except UnicodeError as exc:raise ValueError('Track must use UTF-8 text; compressed KMZ is unsupported') from exc


def _normalized(rows,source,max_gap_s):
    if len(rows)>MAX_TRACK_POINTS:raise ValueError('Track exceeds 100000 observations; select a shorter interval')
    record={'source':source,'altitude_reference':'MSL','max_gap_s':max_gap_s,'points':rows}
    return parse_trajectory(record,datetime.min.replace(tzinfo=timezone.utc),
                            datetime.max.replace(tzinfo=timezone.utc)).to_dict()


def _csv_text(text,source,max_gap_s):
    import io
    reader=csv.DictReader(io.StringIO(text,newline=''))
    if reader.fieldnames is None or len(reader.fieldnames)!=4 or set(reader.fieldnames)!={'time','lat','lon','altitude_m'}:
        raise ValueError('CSV header must contain time,lat,lon,altitude_m')
    rows=[]
    for row in reader:
        if None in row or any(value is None or not value.strip() for value in row.values()):
            raise ValueError(f'CSV row {reader.line_num} needs exactly four nonempty fields')
        try:rows.append({'time':row['time'],**{k:float(row[k]) for k in ('lat','lon','altitude_m')}})
        except ValueError as exc:raise ValueError(f'CSV row {reader.line_num} needs numeric lat,lon,altitude_m') from exc
        if len(rows)>MAX_TRACK_POINTS:raise ValueError('Track exceeds 100000 observations')
    return _normalized(rows,source,max_gap_s)


def read_csv(path,source,max_gap_s=300.):
    """Read the original normalized MSL CSV contract, retaining its source text."""
    return _csv_text(_track_text(path),source,max_gap_s)


def _xml(text):
    import xml.etree.ElementTree as ET
    if re.search(r'<!\s*(?:DOCTYPE|ENTITY)\b',text,re.I):
        raise ValueError('XML DTD/entity declarations are unsupported; no external resources are resolved')
    parser=ET.XMLPullParser(events=('start','end'));root=None;depth=0;count=0
    try:
        for offset in range(0,len(text),65536):
            parser.feed(text[offset:offset+65536])
            for event,element in parser.read_events():
                if event=='start':
                    if root is None:root=element
                    depth+=1;count+=1
                    if depth>32 or count>600000:raise ValueError('XML track exceeds depth/element limits')
                else:depth-=1
        parser.close()
    except ET.ParseError as exc:raise ValueError(f'Invalid track XML: {exc}') from exc
    if root is None:raise ValueError('Empty XML track')
    return root


def _one_text(element,tag,label,required=True):
    values=element.findall(tag)
    if len(values)>1 or (required and len(values)!=1):raise ValueError(f'{label} requires exactly one value')
    if not values:return None
    value=(values[0].text or '').strip()
    if not value or len(values[0]):raise ValueError(f'{label} must be nonempty scalar text')
    return value


def _selected(segments,segment,kind):
    if not segments:raise ValueError(f'No supported {kind} track segments found')
    if segment is None:
        if len(segments)!=1:raise ValueError(f'{kind} has {len(segments)} segments; choose --segment 0 through {len(segments)-1}; segments are never joined')
        segment=0
    if type(segment) is not int or not 0<=segment<len(segments):raise ValueError(f'{kind} segment index must be within 0..{len(segments)-1}')
    return segments[segment],f'{kind} segment {segment} of {len(segments)}'


def _altitude_conversion(reference,offset,kind):
    if reference not in ('msl','ellipsoid'):
        raise ValueError(f'{kind} needs --altitude-reference msl or ellipsoid; the vertical datum is not inferred')
    if reference=='msl':
        if offset is not None:raise ValueError('An altitude offset is supported only for an explicit ellipsoid-to-MSL conversion')
        return 0.,'source altitude declared geometric MSL metres'
    if isinstance(offset,bool) or not isinstance(offset,(float,int)) or not math.isfinite(offset) or abs(offset)>1000:
        raise ValueError('Ellipsoid altitude requires a finite --altitude-offset-m within ±1000 m; MSL = input + offset')
    return float(offset),f'user-declared ellipsoid-to-MSL additive offset {offset:g} m; a verified limited-area approximation, not a global geoid transformation'


def _gpx(root,source,segment,reference,offset,max_gap_s):
    namespace=next((ns for ns in GPX_NAMESPACES if root.tag=='{'+ns+'}gpx'),None)
    if namespace is None:raise ValueError('GPX requires a GPX 1.0 or 1.1 namespaced gpx root')
    q=lambda name:'{'+namespace+'}'+name
    segments=[seg for track in root.findall(q('trk')) for seg in track.findall(q('trkseg'))]
    selected,selection=_selected(segments,segment,'GPX trkseg')
    adjustment,note=_altitude_conversion(reference,offset,'GPX')
    rows=[]
    for point in selected.findall(q('trkpt')):
        if len(rows)>=MAX_TRACK_POINTS:raise ValueError('Track exceeds 100000 observations')
        when=_one_text(point,q('time'),'GPX point time');height=_one_text(point,q('ele'),'GPX point elevation')
        fix=_one_text(point,q('fix'),'GPX fix',False)
        if fix is not None and fix not in ('none','2d','3d','dgps','pps'):raise ValueError('Unsupported GPX fix type')
        if fix in ('none','2d'):raise ValueError('GPX point lacks a valid 3D fix; select a valid segment externally')
        try:rows.append({'time':when,'lat':float(point.attrib['lat']),'lon':float(point.attrib['lon']),'altitude_m':float(height)+adjustment})
        except (KeyError,ValueError) as exc:raise ValueError('GPX points need numeric lat, lon and elevation metres') from exc
    return _normalized(rows,f'{source}; {selection}; {note}; GPX geoidheight is not applied implicitly',max_gap_s)


def _kml(root,source,segment,reference,offset,max_gap_s):
    if root.tag!='{'+KML_NAMESPACE+'}kml':raise ValueError('KML requires the OGC KML 2.2 namespace')
    k=lambda name:'{'+KML_NAMESPACE+'}'+name
    g=lambda name:'{'+GX_NAMESPACE+'}'+name
    tracks=list(root.iter(g('Track')));selected,selection=_selected(tracks,segment,'KML gx:Track')
    if reference not in (None,'msl') or offset is not None:raise ValueError('KML absolute altitude is already MSL; no datum override or offset is applied')
    parents={child:parent for parent in root.iter() for child in parent}
    mode=_one_text(selected,k('altitudeMode'),'KML altitudeMode',False)
    declarations=[mode] if mode else []
    parent=parents.get(selected)
    if parent is not None and parent.tag==g('MultiTrack'):
        shared=_one_text(parent,k('altitudeMode'),'KML MultiTrack altitudeMode',False)
        if shared:declarations.append(shared)
        if parent.find(g('altitudeMode')) is not None:raise ValueError('KML sea-floor altitude modes are unsupported')
    if selected.find(g('altitudeMode')) is not None or not declarations or any(value!='absolute' for value in declarations):
        raise ValueError('KML track requires explicit absolute MSL altitudeMode; clamped, relative and unspecified modes cannot supply flight altitude')
    if selected.find(g('altitudeOffset')) is not None:raise ValueError('Normalize KML altitudeOffset explicitly before importing')
    times=selected.findall(k('when'));coords=selected.findall(g('coord'))
    if len(times)!=len(coords) or len(times)>MAX_TRACK_POINTS:raise ValueError('KML track needs equal bounded counts of when and gx:coord values')
    rows=[]
    for when,coord in zip(times,coords):
        fields=(coord.text or '').split()
        if len(fields)!=3 or len(coord) or len(when) or not (when.text or '').strip():
            raise ValueError('KML track needs a timestamp and three nonempty lon lat altitude values per observation; missing samples are not interpolated on import')
        try:lon,lat,height=map(float,fields)
        except ValueError as exc:raise ValueError('KML coordinates must be numeric lon lat altitude metres') from exc
        rows.append({'time':when.text.strip(),'lat':lat,'lon':lon,'altitude_m':height})
    return _normalized(rows,f'{source}; {selection}; KML absolute geometric MSL metres; separate tracks are never joined',max_gap_s)


def _igc_coordinate(text,latitude):
    width=2 if latitude else 3;degrees=int(text[:width]);minutes=int(text[width:-1])/1000
    maximum=90 if latitude else 180
    if minutes>=60 or degrees>maximum or (degrees==maximum and minutes):raise ValueError('IGC latitude/longitude degrees and decimal minutes are invalid')
    return (degrees+minutes/60)*(-1 if text[-1] in 'SW' else 1)


def _igc(text,source,segment,reference,offset,date,max_gap_s):
    from datetime import date as calendar_date,timedelta
    lines=[line.strip() for line in text.splitlines() if line.strip()]
    if not lines or not re.fullmatch(r'A[A-Z0-9]{3}.+',lines[0]):raise ValueError('IGC requires an initial recorder A record')
    if not isinstance(date,str) or not re.fullmatch(r'\d{4}-\d{2}-\d{2}',date):raise ValueError('IGC needs --date YYYY-MM-DD to resolve its two-digit year without guessing')
    try:day=calendar_date.fromisoformat(date)
    except ValueError as exc:raise ValueError('Invalid explicit IGC date') from exc
    headers=[line for line in lines if re.match(r'H[FOS]DTE',line)]
    if len(headers)!=1:raise ValueError('IGC requires exactly one DTE UTC date header')
    match=re.fullmatch(r'H[FOS]DTE(?:DATE:)?(\d{6})(?:,\d{2})?',headers[0])
    if not match or match[1]!=day.strftime('%d%m%y'):raise ValueError('IGC --date must agree with the DTE header DDMMYY')
    for line in lines:
        if re.match(r'H[FOS]ALG',line):
            datum=line[5:].split(':')[-1].strip()
            if datum!='ELL':raise ValueError('IGC declares non-ellipsoid or unknown GNSS altitude; normalize its documented datum externally')
        if re.match(r'H[FOS]DTM',line):
            datum=re.sub(r'\s+','',line[5:].split(':')[-1]).upper()
            if not re.fullmatch(r'(?:100(?:,WGS-?(?:84|1984))?|WGS-?(?:84|1984))',datum):raise ValueError('IGC horizontal datum must be WGS84')
        if line.startswith('I') and re.search(r'(?:TDS|LAD|LOD)',line):
            raise ValueError('IGC subsecond/extra coordinate precision extensions need explicit external normalization')
    if reference not in (None,'ellipsoid'):raise ValueError('IGC GNSS altitude is ellipsoidal; pressure altitude is never imported as MSL')
    adjustment,note=_altitude_conversion('ellipsoid',offset,'IGC')
    segments=[];active=None;previous=None;invalid=0;missing_altitude=0;rollovers=0;fixes=0
    for number,line in enumerate(lines,1):
        if not line.startswith('B'):continue
        fixes+=1
        if fixes>MAX_TRACK_POINTS:raise ValueError('IGC exceeds 100000 fix records')
        match=re.fullmatch(r'B(\d{6})(\d{7}[NS])(\d{8}[EW])([AV])(-\d{4}|\d{5})(-\d{4}|\d{5})([ -~]*)',line)
        if not match:raise ValueError(f'IGC B record {number} is malformed or lacks altitude')
        clock,latitude,longitude,valid,pressure,gnss=match.groups()[:6]
        hour,minute,second=int(clock[:2]),int(clock[2:4]),int(clock[4:])
        if hour>23 or minute>59 or second>59:raise ValueError('IGC needs ordinary UTC HHMMSS; leap-second fixes require external normalization')
        seconds=hour*3600+minute*60+second
        # The DTE date belongs to the first valid GNSS fix, not earlier RTC fixes.
        if previous is None and valid=='V':invalid+=1;continue
        if previous is not None and seconds<=previous:
            if seconds<previous and previous>=18*3600 and seconds<=6*3600 and previous-seconds>12*3600:
                day+=timedelta(days=1);rollovers+=1
            else:raise ValueError('IGC fix times duplicate or run backwards outside an unambiguous midnight rollover')
        previous=seconds
        if valid=='V':invalid+=1;active=None;continue
        if int(gnss)==0:missing_altitude+=1;active=None;continue
        if active is None:active=[];segments.append(active)
        when=datetime(day.year,day.month,day.day,hour,minute,second,tzinfo=timezone.utc)
        active.append({'time':when.isoformat(),'lat':_igc_coordinate(latitude,True),
                       'lon':_igc_coordinate(longitude,False),'altitude_m':int(gnss)+adjustment})
    selected,selection=_selected(segments,segment,'IGC valid GNSS run')
    notes=f'{selection}; {note}; DTE resolved with explicit date {date}; {rollovers} UTC midnight rollovers; {invalid} V fixes and {missing_altitude} zero-GNSS-altitude fixes excluded as segment breaks; pressure altitude unused; IGC security signature not verified'
    return _normalized(selected,f'{source}; {notes}',max_gap_s)


def read_track(path,source,format='auto',segment=None,altitude_reference=None,
               altitude_offset_m=None,date=None,max_gap_s=300.):
    """Import one explicit recorded segment into the normalized MSL contract.

    Standards: Topografix GPX1.0/1.1, Google's KML2.2 gx:Track, and FAI IGC
    Technical Specification (2023), Appendix A. No network or XML entity loading.
    """
    if not isinstance(source,str) or not source.strip():raise ValueError('Track source must describe whether the input is recorded or synthetic')
    if format not in ('auto','csv','gpx','kml','igc'):raise ValueError('Track format must be auto, csv, gpx, kml or igc')
    text=_track_text(path);root=None
    if format=='auto':
        if text.lstrip().startswith('<'):
            root=_xml(text)
            if root.tag in ['{'+ns+'}gpx' for ns in GPX_NAMESPACES]:format='gpx'
            elif root.tag=='{'+KML_NAMESPACE+'}kml':format='kml'
            else:raise ValueError('Unsupported XML track root/namespace')
        elif re.match(r'A[A-Z0-9]{3}',text.lstrip()):format='igc'
        else:format='csv'
    if format!='igc' and date is not None:raise ValueError('--date is only for IGC; other formats need explicit timestamps')
    if format=='csv':
        if segment is not None or altitude_reference not in (None,'msl') or altitude_offset_m is not None:
            raise ValueError('Normalized CSV is one MSL segment; convert other datums before importing')
        return _csv_text(text,source,max_gap_s)
    if format=='igc':return _igc(text,source,segment,altitude_reference,altitude_offset_m,date,max_gap_s)
    if root is None:root=_xml(text)
    reader=_gpx if format=='gpx' else _kml
    return reader(root,source,segment,altitude_reference,altitude_offset_m,max_gap_s)


def main(argv=None):
    import argparse
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('track',type=Path)
    parser.add_argument('--source',required=True)
    parser.add_argument('--format',choices=('auto','csv','gpx','kml','igc'),default='auto')
    parser.add_argument('--segment',type=int,help='Zero-based segment selection; separate segments are never joined')
    parser.add_argument('--altitude-reference',choices=('msl','ellipsoid'))
    parser.add_argument('--altitude-offset-m',type=float,help='Verified limited-area ellipsoid conversion: MSL = input + offset; not a global geoid model')
    parser.add_argument('--date',help='IGC UTC date YYYY-MM-DD; must match DTE DDMMYY')
    parser.add_argument('--max-gap-s',type=float,default=300.)
    args=parser.parse_args(argv)
    try:
        print(json.dumps(read_track(args.track,args.source,args.format,args.segment,args.altitude_reference,
                                    args.altitude_offset_m,args.date,args.max_gap_s),indent=2,allow_nan=False))
        return 0
    except (OSError,ValueError,OverflowError) as exc:parser.exit(2,f'Track error: {exc}\n')


if __name__=='__main__':main()
