"""Local media validation, preparation and order-independent screen composition."""
from dataclasses import replace
from datetime import timedelta
import hashlib
import json
import math
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from PIL import Image, ImageChops, ImageCms

SCRIPTS = Path(__file__).resolve().parents[1]/'skills/route-replay/scripts'
sys.path[:0] = [str(SCRIPTS),str(SCRIPTS/'engine')]
from trip import load_trip, trip_from_dict
import media_moments as media
from media_overlay import composite


def fixture():
    return load_trip(SCRIPTS.parent/'examples/sample-single-leg.json')


def event(trip, path='photo.png', **overrides):
    when = trip.legs[0].depart+(trip.legs[0].arrive-trip.legs[0].depart)/2
    return dict({'flight':1,'time':when.isoformat(),'path':str(path),'duration_s':2.},**overrides)


def with_events(trip, events):
    return replace(trip,moments=media.validate_moments(events,trip))


class MediaValidationTests(unittest.TestCase):
    def test_optional_defaults_and_physical_clock_roundtrip(self):
        trip = fixture()
        self.assertEqual(media.validate_moments(None,trip),())
        data = trip.to_dict();data['moments']=[event(trip)]
        result = trip_from_dict(data)
        self.assertEqual(result.moments[0]['kind'],'photo')
        self.assertEqual(trip_from_dict(result.to_dict()).moments,result.moments)
        planned = media.plan_moments(result)[0]
        self.assertEqual(result.travel_time(planned['presentation_start_s']),media._instant(result.moments[0]['time']))
        replay = replace(result,weather={'mode':'illustrative_replay','sample_start':'2020-01-01T00:00:00Z','sample_end':'2020-01-02T00:00:00Z'})
        self.assertEqual(media.plan_moments(replay),media.plan_moments(result))

    def test_rejects_nonfinite_unknown_and_unbounded_fields(self):
        trip = fixture()
        cases = [{'duration_s':v} for v in (0,.79,15.1,float('nan'),float('inf'),True)]
        cases += [{'flight':0},{'flight':True},{'flight':2},{'time':'2020-01-01T00:00:00'},
                  {'time':trip.legs[0].depart.isoformat(),'path':'https://example.com/photo.png'},
                  {'path':'photo.svg'},{'path':' '},{'kind':'video'},{'caption':'hello'}, {'start_s':0.}]
        for invalid in cases:
            with self.subTest(invalid=invalid),self.assertRaises(ValueError):
                media.validate_moments([event(trip,**invalid)],trip)
        with self.assertRaisesRegex(ValueError,'at most'):
            media.validate_moments([event(trip)]*65,trip)

    def test_outside_leg_overlap_and_end_window_fail_without_truncation(self):
        trip = fixture()
        with self.assertRaisesRegex(ValueError,'within flight'):
            media.validate_moments([event(trip,time=(trip.legs[0].depart-timedelta(seconds=1)).isoformat())],trip)
        with self.assertRaisesRegex(ValueError,'overlap'):
            media.validate_moments([event(trip),event(trip,path='other.jpg')],trip)
        arrival = event(trip,time=trip.legs[-1].arrive.isoformat())
        self.assertAlmostEqual(media.plan_moments(with_events(trip,[arrival]))[0]['presentation_end_s'],11.3)
        with self.assertRaisesRegex(ValueError,'arrival hold'):
            media.validate_moments([dict(arrival,duration_s=3)],trip)

    def test_relative_paths_resolve_at_original_trip_not_cached_snapshot(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);(root/'images').mkdir()
            Image.new('RGB',(8,8),'red').save(root/'images/p.png')
            trip=fixture();data=trip.to_dict();data['moments']=[event(trip,'images/p.png')]
            source=root/'trip.json';source.write_text(json.dumps(data))
            loaded=load_trip(source)
            self.assertEqual(Path(loaded.moments[0]['path']),(root/'images/p.png').resolve())
            cache=root/'cache';cache.mkdir();(cache/'trip.json').write_text(json.dumps(loaded.to_dict()))
            self.assertEqual(load_trip(cache/'trip.json').moments,loaded.moments)

    def test_multi_leg_repeated_airport_uses_explicit_selected_flight(self):
        data=fixture().to_dict();first=data['flights'][0]
        second=dict(first,**{'from':'AKL','to':'LAX','departure':'2029-11-05T10:00:00+13:00','arrival':'2029-11-05T06:00:00-08:00'})
        data['flights'].append(second);data['video']['duration_s']=24
        trip=trip_from_dict(data)
        arrival=event(trip,flight=2,time=trip.legs[1].arrive.isoformat())
        result=with_events(trip,[arrival]);planned=media.plan_moments(result)[0]
        self.assertEqual(planned['presentation_start_s'],trip.leg_intervals[1][1])
        with self.assertRaisesRegex(ValueError,'within flight'):
            media.validate_moments([dict(arrival,flight=1)],trip)


class PhotoPreparationTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.root=Path(self.temp.name)
        self.path=self.root/'photo.png';Image.new('RGBA',(200,100),(230,30,20,255)).save(self.path)
        self.trip=with_events(fixture(),[event(fixture(),self.path)])
        self.start=media.plan_moments(self.trip)[0]['presentation_start_s']
        self.tick=math.ceil((self.start+.7)*self.trip.fps)

    def tearDown(self):
        self.temp.cleanup()

    def test_identity_is_content_based_and_needs_real_decodable_files(self):
        first=media.media_identity(self.trip)
        Image.new('RGB',(200,100),'blue').save(self.path)
        self.assertNotEqual(first['sources'][0]['sha256'],media.media_identity(self.trip)['sources'][0]['sha256'])
        self.assertIn('Pillow',first['decoders'])
        self.path.write_bytes(b'not a PNG')
        with self.assertRaisesRegex(ValueError,'Invalid'):
            media.media_identity(self.trip)
        with self.assertRaisesRegex(ValueError,'Resolve'):
            media.media_identity(with_events(fixture(),[event(fixture(),'relative.png')]))

    def test_photo_fit_metadata_orientation_and_tiny_image(self):
        jpeg=self.root/'oriented.jpg'
        image=Image.new('RGB',(80,40),'red');exif=Image.Exif();exif[274]=6;exif[270]='private description'
        image.save(jpeg,exif=exif)
        trip=with_events(fixture(),[event(fixture(),jpeg)])
        manifest=media.prepare_moments(trip,self.root/'work',[self.tick])
        with Image.open(self.root/'work'/manifest['events'][0]['photo']['path']) as result:
            self.assertEqual(result.size,(40,80))
            self.assertFalse(result.getexif())
            self.assertNotIn('exif',result.info)
        self.assertEqual(manifest['fit'],'contain')
        self.assertEqual(manifest['audio'],'discarded')

    def test_prepares_only_requested_events_and_cache_survives_repeat(self):
        work=self.root/'work'
        empty=media.prepare_moments(self.trip,work,[0])
        self.assertIsNone(empty['events'][0]['photo'])
        manifest=media.prepare_moments(self.trip,work,[self.tick])
        path=work/manifest['events'][0]['photo']['path'];stamp=path.stat().st_mtime_ns
        with patch.object(media,'_save_photo',side_effect=AssertionError('unneeded decode')):
            again=media.prepare_moments(self.trip,work,[self.tick,self.tick])
        self.assertEqual(manifest,again);self.assertEqual(path.stat().st_mtime_ns,stamp)

    def test_embedded_srgb_profile_is_applied_then_removed(self):
        profile=ImageCms.ImageCmsProfile(ImageCms.createProfile('sRGB')).tobytes()
        Image.new('RGB',(20,10),(70,120,180)).save(self.path,icc_profile=profile)
        manifest=media.prepare_moments(self.trip,self.root/'work',[self.tick])
        with Image.open(self.root/'work'/manifest['events'][0]['photo']['path']) as result:
            self.assertEqual(result.getpixel((10,5)),(70,120,180,255))
            self.assertNotIn('icc_profile',result.info)

    def test_palette_and_grayscale_srgb_profiles_preserve_color_and_alpha(self):
        profile=ImageCms.ImageCmsProfile(ImageCms.createProfile('sRGB')).tobytes()
        palette=Image.new('P',(20,10),0)
        palette.putpalette([70,120,180]+[0,0,0]*255)
        palette.info['transparency']=bytes([73]+[255]*255)
        cases=[('palette',palette,(70,120,180,73)),
               ('gray',Image.new('L',(20,10),91),(91,91,91,255)),
               ('gray_alpha',Image.new('LA',(20,10),(91,63)),(91,91,91,63)),
               ('rgba',Image.new('RGBA',(20,10),(70,120,180,117)),(70,120,180,117))]
        for name,image,expected in cases:
            with self.subTest(mode=name):
                source=self.root/f'{name}.png';image.save(source,icc_profile=profile)
                trip=with_events(fixture(),[event(fixture(),source)])
                work=self.root/name;manifest=media.prepare_moments(trip,work,[self.tick])
                with Image.open(work/manifest['events'][0]['photo']['path']) as result:
                    self.assertEqual(result.getpixel((10,5)),expected)
                    self.assertNotIn('icc_profile',result.info)

    def test_mismatched_real_rgb_and_lab_profiles_are_rejected(self):
        cases=[('cmyk',Image.new('CMYK',(20,10),(10,180,180,20)),'sRGB','.jpg'),
               ('rgb',Image.new('RGB',(20,10),(200,30,30)),'LAB','.png')]
        for name,image,profile_name,suffix in cases:
            with self.subTest(profile=profile_name,image_mode=image.mode):
                path=self.root/(name+suffix)
                image.save(path,icc_profile=ImageCms.ImageCmsProfile(ImageCms.createProfile(profile_name)).tobytes())
                trip=with_events(fixture(),[event(fixture(),path)])
                with self.assertRaisesRegex(ValueError,'export it as sRGB'):
                    media.prepare_moments(trip,self.root/name,[self.tick])

    def test_gray_and_cmyk_profile_mismatch_fails_before_transform(self):
        Image.new('RGB',(20,10),(200,30,30)).save(self.path,icc_profile=b'profile-header-fixture')
        for color_space in ('GRAY','CMYK'):
            # Isolate the parsed profile header; a mismatched sample layout must
            # be rejected before any pixel conversion or LittleCMS transform.
            parsed=SimpleNamespace(profile=SimpleNamespace(xcolor_space=color_space))
            with self.subTest(color_space=color_space),patch.object(ImageCms,'ImageCmsProfile',return_value=parsed):
                with patch.object(ImageCms,'profileToProfile',return_value=Image.new('RGB',(20,10))) as transform:
                    with self.assertRaisesRegex(ValueError,'export it as sRGB'):
                        media.prepare_moments(self.trip,self.root/color_space,[self.tick])
                    transform.assert_not_called()

    def test_high_depth_grayscale_rejected_with_and_without_profile(self):
        profile=ImageCms.ImageCmsProfile(ImageCms.createProfile('sRGB')).tobytes()
        for with_profile in (False,True):
            with self.subTest(profile=with_profile):
                Image.new('I;16',(20,10),300).save(self.path,**({'icc_profile':profile} if with_profile else {}))
                with self.assertRaisesRegex(ValueError,'8-bit sRGB'):
                    media.prepare_moments(self.trip,self.root/f'high-{with_profile}',[self.tick])
        for mode in ('I','F'):
            for with_profile in (False,True):
                image=Image.new(mode,(20,10),300)
                if with_profile:image.info['icc_profile']=profile
                with self.subTest(mode=mode,profile=with_profile),patch.object(Image,'open',return_value=image):
                    with self.assertRaisesRegex(ValueError,'8-bit sRGB'):
                        media._save_photo(self.path,self.root/'unused.png')

    def test_source_changed_during_decode_is_rejected(self):
        original=media._save_photo
        def mutate(path,output):
            original(path,output);Image.new('RGB',(20,20),'green').save(path)
        with patch.object(media,'_save_photo',side_effect=mutate),self.assertRaisesRegex(ValueError,'changed during'):
            media.prepare_moments(self.trip,self.root/'work',[self.tick])
        self.assertFalse((self.root/'work/media-moments.json').exists())

    def test_cache_identity_change_fails_before_decode(self):
        identity=media.media_identity(self.trip)
        Image.new('RGB',(20,20),'green').save(self.path)
        with patch.object(media,'_save_photo',side_effect=AssertionError('must fail before decode')):
            with self.assertRaisesRegex(ValueError,'since render cache identity'):
                media.prepare_moments(self.trip,self.root/'work',[self.tick],expected_identity=identity)

    def test_composition_safe_area_no_crop_and_shuffled_access(self):
        work=self.root/'work';media.prepare_moments(self.trip,work,[self.tick])
        background=Image.new('RGB',(1080,1920),(80,100,120));t=self.tick/self.trip.fps
        with patch('subprocess.run',side_effect=AssertionError('no subprocess during compositing')):
            first=composite(background,t,work)
            composite(background,t+.2,work)
            second=composite(background,t,work)
        self.assertEqual(first.tobytes(),second.tobytes())
        self.assertEqual(background.getpixel((540,1400)),(80,100,120))
        box=ImageChops.difference(first.convert('RGB'),background).getbbox()
        self.assertGreaterEqual(box[0],110);self.assertLessEqual(box[2],970)
        self.assertGreaterEqual(box[1],1260);self.assertLessEqual(box[3],1710)
        self.assertEqual(first.getpixel((540,1485)),(230,30,20,255))
        self.assertIs(composite(background,self.start,work),background)
        self.assertIs(composite(background,self.start+2,work),background)

    def test_active_unprepared_frame_errors_and_prepared_tamper_is_repaired(self):
        work=self.root/'work'
        with self.assertRaisesRegex(ValueError,'manifest is missing'):
            composite(Image.new('RGB',(1080,1920)),0,work)
        media.prepare_moments(self.trip,work,[0])
        with self.assertRaisesRegex(ValueError,'not prepared'):
            composite(Image.new('RGB',(1080,1920)),self.tick/self.trip.fps,work)
        prepared=media.prepare_moments(self.trip,work,[self.tick]);record=prepared['events'][0]['photo']
        path=work/record['path'];path.write_bytes(b'broken')
        fixed=media.prepare_moments(self.trip,work,[self.tick])
        self.assertEqual(fixed['events'][0]['photo']['sha256'],record['sha256'])


@unittest.skipUnless(shutil.which('ffmpeg') and shutil.which('ffprobe'),'ffmpeg/ffprobe unavailable')
class VideoPreparationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp=tempfile.TemporaryDirectory();cls.root=Path(cls.temp.name)
        for tick in range(40):
            color=('red','lime','blue','yellow')[tick//10]
            Image.new('RGB',(160,90),color).save(cls.root/f'source-{tick:03d}.png')
        cls.video=cls.root/'source.mp4'
        subprocess.run([shutil.which('ffmpeg'),'-v','error','-framerate','10','-i',str(cls.root/'source-%03d.png'),
                        '-c:v','libx264rgb','-crf','0','-pix_fmt','rgb24','-threads','1','-y',str(cls.video)],check=True)

    @classmethod
    def tearDownClass(cls):
        cls.temp.cleanup()

    def test_sparse_and_full_decode_match_and_start_s_is_respected(self):
        trip=fixture();trip=with_events(trip,[event(trip,self.video,start_s=1.2,duration_s=1.6)])
        start=media.plan_moments(trip)[0]['presentation_start_s']
        ticks=[math.ceil((start+offset)*trip.fps) for offset in (.15,.65,1.15)]
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);sparse=media.prepare_moments(trip,root/'sparse',list(reversed(ticks)))
            full=media.prepare_moments(trip,root/'full')
            self.assertEqual(len(sparse['events'][0]['frames']),3)
            for tick in ticks:
                a=sparse['events'][0]['frames'][str(tick)];b=full['events'][0]['frames'][str(tick)]
                self.assertEqual(a['sha256'],b['sha256'])
            with Image.open(root/'sparse'/sparse['events'][0]['frames'][str(ticks[0])]['path']) as image:
                r,g,b=image.convert('RGB').getpixel((image.width//2,image.height//2))
                self.assertGreater(g,240);self.assertLess(max(r,b),5)
            with Image.open(root/'sparse'/sparse['events'][0]['frames'][str(ticks[-1])]['path']) as image:
                self.assertGreater(image.convert('RGB').getpixel((image.width//2,image.height//2))[2],240)
            repeated=media.prepare_moments(trip,root/'sparse',[ticks[1]])
            self.assertEqual(repeated,sparse)
            image=Image.new('RGB',(1080,1920),'white')
            with patch('subprocess.run',side_effect=AssertionError('decode in renderer')):
                a=composite(image,ticks[0]/trip.fps,root/'sparse')
                composite(image,ticks[-1]/trip.fps,root/'sparse')
                self.assertEqual(a.tobytes(),composite(image,ticks[0]/trip.fps,root/'sparse').tobytes())

    def test_frame_boundary_decode_matches_sparse_full_and_shuffled_requests(self):
        boundary=31/30
        self.assertGreater(boundary*30,31) # product rounding used to skip the selected frame31
        for start in (math.nextafter(boundary,-math.inf),boundary,math.nextafter(boundary,math.inf)):
            with self.subTest(start=start),tempfile.TemporaryDirectory() as tmp:
                data=fixture().to_dict();data['video']['departure_hold_s']=start
                trip=trip_from_dict(data)
                trip=with_events(trip,[event(trip,self.video,time=trip.legs[0].depart.isoformat(),duration_s=.8,start_s=1.2)])
                self.assertEqual(media.plan_moments(trip)[0]['presentation_start_s'],start)
                active=[tick for tick in range(trip.frame_count) if start<=tick/trip.fps<start+.8]
                selected=[active[0],active[5],active[-1]]
                root=Path(tmp)
                sparse=media.prepare_moments(trip,root/'sparse',list(reversed(selected)))
                full=media.prepare_moments(trip,root/'full')
                late_only=media.prepare_moments(trip,root/'late',[selected[-1]])
                self.assertEqual(set(full['events'][0]['frames']),set(map(str,active)))
                for tick in selected:
                    self.assertEqual(sparse['events'][0]['frames'][str(tick)]['sha256'],full['events'][0]['frames'][str(tick)]['sha256'])
                self.assertEqual(late_only['events'][0]['frames'][str(selected[-1])]['sha256'],full['events'][0]['frames'][str(selected[-1])]['sha256'])

    def test_truncated_range_and_invalid_video_fail_before_preparation(self):
        trip=fixture()
        with self.assertRaisesRegex(ValueError,'exceeds'):
            media.media_identity(with_events(trip,[event(trip,self.video,start_s=3,duration_s=2)]))
        with tempfile.TemporaryDirectory() as tmp:
            invalid=Path(tmp)/'invalid.mp4';invalid.write_text('not a stream')
            with self.assertRaisesRegex(ValueError,'probe/decode failed'):
                media.media_identity(with_events(trip,[event(trip,invalid,start_s=0)]))

    def test_video_preserves_non_square_pixel_display_aspect(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);video=root/'wide.mp4'
            subprocess.run([shutil.which('ffmpeg'),'-v','error','-i',str(self.video),'-vf','setsar=2',
                            '-c:v','libx264rgb','-crf','0','-threads','1','-y',str(video)],check=True)
            trip=fixture();trip=with_events(trip,[event(trip,video)])
            start=media.plan_moments(trip)[0]['presentation_start_s'];tick=math.ceil((start+.5)*trip.fps)
            result=media.prepare_moments(trip,root/'work',[tick])
            with Image.open(root/'work'/result['events'][0]['frames'][str(tick)]['path']) as image:
                self.assertAlmostEqual(image.width/image.height,160*2/90,delta=.02)
                self.assertLessEqual(image.width,860);self.assertLessEqual(image.height,450)

    def test_hdr_transfer_is_rejected_with_sdr_conversion_guidance(self):
        with tempfile.TemporaryDirectory() as tmp:
            video=Path(tmp)/'hdr.mp4'
            subprocess.run([shutil.which('ffmpeg'),'-v','error','-i',str(self.video),
                            '-x264-params','colorprim=bt2020:transfer=smpte2084:colormatrix=bt2020nc','-pix_fmt','yuv420p',
                            '-c:v','libx264','-crf','0','-threads','1','-y',str(video)],check=True)
            trip=fixture();trip=with_events(trip,[event(trip,video)])
            with self.assertRaisesRegex(ValueError,'export an SDR version'):
                media.media_identity(trip)


if __name__=='__main__':
    unittest.main()
