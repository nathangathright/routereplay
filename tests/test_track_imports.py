"""Provider-format time, segment and vertical-datum boundaries without network."""
from datetime import datetime,timezone
import json
from pathlib import Path
import subprocess,sys,tempfile,unittest
from unittest.mock import patch
SCRIPTS=Path(__file__).resolve().parents[1]/'skills/route-replay/scripts'
sys.path.insert(0,str(SCRIPTS))
from trajectory import read_csv,read_track,parse_trajectory

SOURCE='Synthetic format fixture, not an observed flight'
CSV='time,lat,lon,altitude_m\n2023-10-01T00:00:00Z,41,-87,100\n2023-10-01T00:01:00Z,42,-88,200\n'
GPX_NS='http://www.topografix.com/GPX/1/1'
KML_NS='http://www.opengis.net/kml/2.2'
GX_NS='http://www.google.com/kml/ext/2.2'


def gpx_point(time='2023-10-01T00:00:00Z',lat='41',lon='-87',elevation='150',extra=''):
    return f'<trkpt lat="{lat}" lon="{lon}"><ele>{elevation}</ele><time>{time}</time>{extra}</trkpt>'


def gpx(*segments,namespace=GPX_NS):
    return f'<gpx xmlns="{namespace}" version="1.1" creator="fixture"><trk>'+''.join('<trkseg>'+segment+'</trkseg>' for segment in segments)+'</trk></gpx>'


def kml_track(mode='<altitudeMode>absolute</altitudeMode>',coords=None,times=None):
    if coords is None:coords=['-87 41 150','-88 42 250']
    if times is None:times=['2023-10-01T00:00:00Z','2023-10-01T00:01:00Z']
    return '<gx:Track>'+mode+''.join(f'<when>{x}</when>' for x in times)+''.join(f'<gx:coord>{x}</gx:coord>' for x in coords)+'</gx:Track>'


def kml(body):return f'<kml xmlns="{KML_NS}" xmlns:gx="{GX_NS}"><Document><Placemark>'+body+'</Placemark></Document></kml>'


def fix(clock='000000',valid='A',gnss=200,pressure=9999,lat='4150000N',lon='08730000W'):
    return f'B{clock}{lat}{lon}{valid}{pressure:05d}{gnss:05d}'


def igc(*records,date='011023',extra=''):
    return '\n'.join(['AXXXSYNTHETIC','HFDTE'+date,'HFDTMGPSDATUM:WGS84','HFALGGNSSALTITUDE:ELL',extra,*records])+'\n'


class TrackImportTests(unittest.TestCase):
    def setUp(self):self.tmp=tempfile.TemporaryDirectory();self.root=Path(self.tmp.name)
    def tearDown(self):self.tmp.cleanup()
    def file(self,text,name='track.data'):
        path=self.root/name;path.write_text(text);return path
    def two_gpx(self,extra=''):
        return gpx(gpx_point(extra=extra)+gpx_point(time='2023-10-01T00:01:00Z',lat='42',elevation='250',extra=extra))
    def import_igc(self,text,**options):
        return read_track(self.file(text),SOURCE,date=options.pop('date','2023-10-01'),altitude_offset_m=options.pop('altitude_offset_m',-30),**options)

    def test_csv_invocation_and_public_api_remain_compatible(self):
        path=self.file(CSV,'misleading.gpx')
        result=read_track(path,SOURCE)
        self.assertEqual(result,read_csv(path,SOURCE));self.assertEqual(result['source'],SOURCE)
        run=subprocess.run([sys.executable,str(SCRIPTS/'trajectory.py'),str(path),'--source',SOURCE],capture_output=True,text=True)
        self.assertEqual(run.returncode,0,run.stderr);self.assertEqual(json.loads(run.stdout),result)
        with self.assertRaisesRegex(ValueError,'MSL segment'):read_track(path,SOURCE,altitude_reference='ellipsoid',altitude_offset_m=0)

    def test_gpx_explicit_datum_units_timezone_and_geoid_not_implicit(self):
        text=gpx(gpx_point(time='2023-09-30T19:00:00-05:00',extra='<geoidheight>20</geoidheight>')+gpx_point(time='2023-10-01T00:01:00Z',elevation='250'))
        path=self.file(text)
        with self.assertRaisesRegex(ValueError,'datum is not inferred'):read_track(path,SOURCE)
        msl=read_track(path,SOURCE,altitude_reference='msl')
        self.assertEqual(msl['points'][0]['time'],'2023-10-01T00:00:00Z');self.assertEqual(msl['points'][0]['altitude_m'],150)
        ellipsoid=read_track(path,SOURCE,altitude_reference='ellipsoid',altitude_offset_m=-30)
        self.assertEqual([p['altitude_m'] for p in ellipsoid['points']],[120,220])
        self.assertIn('limited-area',ellipsoid['source'])
        for offset in (None,float('nan'),1001):
            with self.assertRaises(ValueError):read_track(path,SOURCE,altitude_reference='ellipsoid',altitude_offset_m=offset)
        with self.assertRaises(ValueError):read_track(path,SOURCE,altitude_reference='pressure')

    def test_gpx_10_and_segments_are_selected_not_joined(self):
        first=gpx_point()+gpx_point(time='2023-10-01T00:01:00Z')
        second=gpx_point(time='2023-10-02T00:00:00Z')+gpx_point(time='2023-10-02T00:01:00Z')
        path=self.file(gpx(first,second,namespace='http://www.topografix.com/GPX/1/0'))
        with self.assertRaisesRegex(ValueError,'2 segments'):read_track(path,SOURCE,altitude_reference='msl')
        result=read_track(path,SOURCE,segment=1,altitude_reference='msl')
        self.assertEqual(len(result['points']),2);self.assertTrue(result['points'][0]['time'].startswith('2023-10-02'))
        self.assertIn('segment 1 of 2',result['source'])
        for selection in (-1,2,True):
            with self.assertRaises(ValueError):read_track(path,SOURCE,segment=selection,altitude_reference='msl')

    def test_gpx_missing_values_invalid_fixes_and_chronology_rejected(self):
        text=self.two_gpx()
        broken=[text.replace('<ele>150</ele>',''),text.replace('<time>2023-10-01T00:00:00Z</time>',''),
                text.replace('00:01:00Z','00:00:00Z'),text.replace('00:00:00Z','00:00:00'),
                text.replace('<ele>150</ele>','<ele>NaN</ele>'),self.two_gpx('<fix>2d</fix>')]
        for value in broken:
            with self.subTest(value=value),self.assertRaises(ValueError):read_track(self.file(value),SOURCE,altitude_reference='msl')
        with self.assertRaises(ValueError):read_track(self.file(gpx('')),SOURCE,altitude_reference='msl')

    def test_kml_absolute_coordinates_and_southern_dateline_values(self):
        result=read_track(self.file(kml(kml_track(coords=['179.9 -37 150','-179.9 -38 250']))),SOURCE)
        self.assertEqual(result['points'][0]['lat'],-37);self.assertEqual(result['points'][0]['lon'],179.9)
        self.assertEqual(result['points'][1]['altitude_m'],250)
        self.assertIn('absolute geometric MSL',result['source'])

    def test_kml_relative_clamped_ambiguous_or_missing_altitude_fails(self):
        modes=['','<altitudeMode>clampToGround</altitudeMode>','<altitudeMode>relativeToGround</altitudeMode>',
               '<gx:altitudeMode>relativeToSeaFloor</gx:altitudeMode>']
        for mode in modes:
            with self.subTest(mode=mode),self.assertRaisesRegex(ValueError,'absolute MSL'):read_track(self.file(kml(kml_track(mode))),SOURCE)
        for coords in (['-87 41','-88 42 250'],['','-88 42 250'],['-87,41,150','-88 42 250']):
            with self.assertRaises(ValueError):read_track(self.file(kml(kml_track(coords=coords))),SOURCE)
        with self.assertRaisesRegex(ValueError,'equal bounded'):read_track(self.file(kml(kml_track(times=['2023-10-01T00:00:00Z']))),SOURCE)
        with self.assertRaises(ValueError):read_track(self.file(kml(kml_track())),SOURCE,altitude_reference='ellipsoid',altitude_offset_m=0)

    def test_kml_multitrack_selection_inherits_explicit_absolute_mode(self):
        body='<gx:MultiTrack><altitudeMode>absolute</altitudeMode><gx:interpolate>1</gx:interpolate>'+kml_track(mode='')+kml_track(mode='',coords=['-86 40 100','-85 41 200'])+'</gx:MultiTrack>'
        path=self.file(kml(body))
        with self.assertRaisesRegex(ValueError,'2 segments'):read_track(path,SOURCE)
        result=read_track(path,SOURCE,segment=1);self.assertEqual(result['points'][0]['lon'],-86)
        with self.assertRaises(ValueError):read_track(self.file(kml(body.replace('<altitudeMode>absolute','<altitudeMode>relativeToGround'))),SOURCE,segment=0)

    def test_igc_midnight_negative_gnss_altitude_and_pressure_separation(self):
        result=self.import_igc(igc(fix('235959',gnss=200),fix('000100',gnss=-100)),max_gap_s=60)
        a,b=result['points'];self.assertEqual(a['time'],'2023-10-01T23:59:59Z');self.assertEqual(b['time'],'2023-10-02T00:01:00Z')
        self.assertEqual([a['altitude_m'],b['altitude_m']],[170,-130]);self.assertAlmostEqual(a['lat'],41+50/60);self.assertEqual(a['lon'],-87.5)
        parsed=parse_trajectory(result,datetime(2023,10,1,tzinfo=timezone.utc),datetime(2023,10,3,tzinfo=timezone.utc))
        self.assertTrue(any(g['reason']=='observation_gap' for g in parsed.gaps(parsed.points[0].time,parsed.points[-1].time)))
        self.assertIn('1 UTC midnight rollovers',result['source']);self.assertIn('pressure altitude unused',result['source'])

    def test_igc_date_century_and_required_offset(self):
        path=self.file(igc(fix(),fix('000100')))
        with self.assertRaisesRegex(ValueError,'two-digit year'):read_track(path,SOURCE,altitude_offset_m=-30)
        for date in ('2023-10-02','2023-02-30','23-10-01'):
            with self.assertRaises(ValueError):read_track(path,SOURCE,date=date,altitude_offset_m=-30)
        with self.assertRaisesRegex(ValueError,'altitude-offset'):read_track(path,SOURCE,date='2023-10-01')
        with self.assertRaises(ValueError):read_track(path,SOURCE,date='2023-10-01',altitude_reference='msl')
        result=read_track(path,SOURCE,date='1923-10-01',altitude_offset_m=0)
        self.assertTrue(result['points'][0]['time'].startswith('1923-10-01'))
        dated=igc(fix(),fix('000100')).replace('HFDTE011023','HFDTEDATE:011023,01')
        self.assertEqual(self.import_igc(dated)['points'][0]['time'],'2023-10-01T00:00:00Z')

    def test_igc_invalid_and_zero_altitude_split_without_bridging(self):
        value=igc(fix('235959',valid='V',gnss=0),fix('000000'),fix('000100'),fix('000200',valid='V',gnss=0),fix('000300'),fix('000400'))
        with self.assertRaisesRegex(ValueError,'2 segments'):self.import_igc(value)
        result=self.import_igc(value,segment=1)
        self.assertEqual(result['points'][0]['time'],'2023-10-01T00:03:00Z')
        self.assertIn('2 V fixes',result['source'])
        zero=value.replace(fix('000200',valid='V',gnss=0),fix('000200',gnss=0))
        with self.assertRaisesRegex(ValueError,'2 segments'):self.import_igc(zero)
        self.assertIn('1 zero-GNSS-altitude',self.import_igc(zero,segment=1)['source'])

    def test_igc_corrupt_dates_datum_and_reverse_clock_rejected(self):
        broken=[igc(fix('120000'),fix('115959')),igc(fix(),fix()),igc(fix('246000'),fix('000100')),
                igc(fix(lat='4160000N'),fix('000100')),igc(fix(),fix('000100')).replace('WGS84','NAD83'),
                igc(fix(),fix('000100')).replace(':ELL',':GEO'),igc(fix(),fix('000100'),extra='I013636TDS'),
                igc(fix(),fix('000100'))+'HFDTE011023\n',igc(fix()[:-3],fix('000100'))]
        for value in broken:
            with self.subTest(value=value),self.assertRaises(ValueError):self.import_igc(value)

    def test_xml_dtd_entities_external_resources_and_bounded_inputs(self):
        malicious='<!DOCTYPE gpx [<!ENTITY e SYSTEM "file:///private/anything">]>'+self.two_gpx().replace('<ele>150</ele>','<ele>&e;</ele>')
        with patch('urllib.request.urlopen',side_effect=AssertionError('No network')):
            with self.assertRaisesRegex(ValueError,'DTD/entity'):read_track(self.file(malicious),SOURCE,altitude_reference='msl')
        with patch('trajectory.MAX_TRACK_BYTES',8),self.assertRaisesRegex(ValueError,'32 MiB'):read_track(self.file(CSV),SOURCE)
        with patch('trajectory.MAX_TRACK_POINTS',1),self.assertRaisesRegex(ValueError,'100000'):read_track(self.file(self.two_gpx()),SOURCE,altitude_reference='msl')
        with self.assertRaisesRegex(ValueError,'depth/element'):read_track(self.file('<x>'*34+'</x>'*34),SOURCE,format='gpx',altitude_reference='msl')

    def test_timestamp_without_actual_timezone_is_not_localized(self):
        text=CSV.replace('2023-10-01T00:00:00Z','2023-10-01+00:00')
        with self.assertRaisesRegex(ValueError,'time is invalid'):read_track(self.file(text),SOURCE)

    def test_standalone_gpx_and_igc_clis_emit_normalized_json(self):
        for text,options in [(self.two_gpx(),['--format','gpx','--altitude-reference','msl']),
                             (igc(fix(),fix('000100')),['--format','igc','--date','2023-10-01','--altitude-offset-m','-30'])]:
            path=self.file(text)
            run=subprocess.run([sys.executable,str(SCRIPTS/'trajectory.py'),str(path),'--source',SOURCE,*options],capture_output=True,text=True)
            self.assertEqual(run.returncode,0,run.stderr);self.assertEqual(json.loads(run.stdout)['altitude_reference'],'MSL')
        run=subprocess.run([sys.executable,str(SCRIPTS/'trajectory.py'),str(self.file(self.two_gpx())),'--source',SOURCE],capture_output=True,text=True)
        self.assertEqual(run.returncode,2);self.assertIn('vertical datum',run.stderr)


if __name__=='__main__':unittest.main()
