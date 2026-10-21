"""Import a real-shaped file into a trip without altering originals or bypassing validation."""
from contextlib import redirect_stdout,redirect_stderr
import io
import json
import shutil
from pathlib import Path
import sys
import tempfile
import unittest

SCRIPTS=Path(__file__).resolve().parents[1]/'skills/route-replay/scripts'
sys.path.insert(0,str(SCRIPTS))
from flight_video import main
from trip import load_trip


class TrackWorkflowTests(unittest.TestCase):
    def prepare(self,root):
        original=SCRIPTS.parent/'examples/sample-trajectory.json'
        data=json.loads(original.read_text())
        points=data['flights'][0].pop('trajectory')['points']
        trip=root/'trip.json';trip.write_text(json.dumps(data))
        track=root/'track.gpx'
        track.write_text('<gpx version="1.1" xmlns="http://www.topografix.com/GPX/1/1"><trk><trkseg>'+''.join(
            f'<trkpt lat="{p["lat"]}" lon="{p["lon"]}"><ele>{p["altitude_m"]}</ele><time>{p["time"]}</time></trkpt>' for p in points
        )+'</trkseg></trk></gpx>')
        return trip,track

    def invoke(self,trip,track,output,*extra):
        with redirect_stdout(io.StringIO()) as out:
            main(['import-track',str(trip),str(track),'--flight','1','--source','Synthetic test flight',
                  '--altitude-reference','msl','--output',str(output),*extra])
        return json.loads(out.getvalue())

    def test_import_attaches_validated_track_and_enables_overlay(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);trip,track=self.prepare(root)
            original=trip.read_bytes();track_bytes=track.read_bytes()
            output=root/'imported.json'
            result=self.invoke(trip,track,output,'--telemetry')
            loaded=load_trip(output)
            self.assertEqual(result['points'],5)
            self.assertEqual(loaded.legs[0].trajectory.points[0].altitude_m,210)
            self.assertTrue(loaded.telemetry['enabled'])
            self.assertEqual(trip.read_bytes(),original)
            self.assertEqual(track.read_bytes(),track_bytes)
            self.assertTrue(result['gaps'])

    def test_import_rebases_media_and_remains_relocatable(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);trip,track=self.prepare(root)
            media=root/'media';media.mkdir();(media/'window.jpg').write_bytes(b'photo fixture')
            data=json.loads(trip.read_text())
            data['moments']=[{'flight':1,'time':data['flights'][0]['departure'],
                              'path':'media/window.jpg','duration_s':1}]
            trip.write_text(json.dumps(data));before=trip.read_bytes()
            output=root/'edits'/'imported.json';output.parent.mkdir()
            self.invoke(trip,track,output)
            saved=json.loads(output.read_text())
            self.assertEqual(saved['moments'][0]['path'],'../media/window.jpg')
            self.assertNotIn(str(root.resolve()),output.read_text())
            self.assertEqual(Path(load_trip(output).moments[0]['path']),(media/'window.jpg').resolve())
            relocated=root/'moved';relocated.mkdir()
            shutil.copytree(media,relocated/'media');shutil.copytree(output.parent,relocated/'edits')
            self.assertEqual(Path(load_trip(relocated/'edits/imported.json').moments[0]['path']),
                             (relocated/'media/window.jpg').resolve())
            self.assertEqual(trip.read_bytes(),before)

    def test_failed_chronology_creates_no_output(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);trip,track=self.prepare(root)
            data=json.loads(trip.read_text())
            data['flights'][0]['departure']='2031-01-05T11:00:00-06:00'
            trip.write_text(json.dumps(data));output=root/'invalid.json'
            with redirect_stderr(io.StringIO()) as err,self.assertRaises(SystemExit) as result:
                self.invoke(trip,track,output)
            self.assertEqual(result.exception.code,2)
            self.assertIn('within',err.getvalue())
            self.assertFalse(output.exists())

    def test_originals_and_existing_outputs_cannot_be_overwritten(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);trip,track=self.prepare(root)
            for output in (trip,track):
                before=output.read_bytes()
                with redirect_stderr(io.StringIO()),self.assertRaises(SystemExit):
                    self.invoke(trip,track,output)
                self.assertEqual(output.read_bytes(),before)
            output=root/'imported.json';self.invoke(trip,track,output)
            replaced=root/'replaced.json'
            with redirect_stderr(io.StringIO()) as err,self.assertRaises(SystemExit):
                self.invoke(output,track,replaced)
            self.assertIn('--replace-trajectory',err.getvalue())
            self.assertFalse(replaced.exists())
            self.invoke(output,track,replaced,'--replace-trajectory')
            self.assertTrue(replaced.is_file())


if __name__=='__main__':unittest.main()
