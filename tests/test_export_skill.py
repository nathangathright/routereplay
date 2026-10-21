"""The standalone distribution must never silently drop required tests."""
from pathlib import Path
import os
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'tools'))
import export_skill_repo as exporter


class DistributionTests(unittest.TestCase):
    def test_checkout_ignore_rules_match_exported_rules(self):
        self.assertEqual((exporter.ROOT/'.gitignore').read_text(),exporter.PORTABLE_IGNORE)

    def test_public_audit_rejects_private_binary_media_and_large_files(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory).resolve()
            cases={
                '.env.local': ('TOKEN=test', 'credential'),
                'nested/credentials.json': ('{}', 'credential'),
                'private/booking.json': ('{}', 'credential'),
                'demo.MP4': ('media', 'generated asset'),
                'recording.gpx': ('<gpx/>', 'generated asset'),
                'hidden.dat': (b'\x00\x01\xff', 'binary'),
                'big.txt': ('x' * (exporter.MAX_FILE_BYTES+1), '1 MiB'),
                'notes.md': ('/'+'Users'+'/someone/project', 'home path'),
                'links.md': ('https://'+'example.tailnet'+'.ts.net/', 'tailnet'),
                'doc.md': ('https://docs.google.com/'+'document/d/'+'test', 'document link'),
                'email.md': ('person'+'@'+'gmail.com', 'email address'),
                'key.txt': ('-----BEGIN '+'RSA PRIVATE KEY-----', 'private key material'),
                'github.txt': ('gh'+'p_'+'a'*36, 'GitHub token'),
                'aws.txt': ('AK'+'IA'+'A'*16, 'AWS access key'),
                'slack.txt': ('xox'+'b-'+'a'*24, 'Slack token'),
            }
            for name,(data,reason) in cases.items():
                with self.subTest(name=name):
                    path=root/name; path.parent.mkdir(parents=True,exist_ok=True)
                    path.write_bytes(data if isinstance(data,bytes) else data.encode())
                    with self.assertRaisesRegex(ValueError,reason):
                        exporter.audit(root,[path])

    def test_public_audit_allows_source_and_explicit_bundled_font(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory).resolve()
            source=root/'source.py';source.write_text('print("Route Replay")\n')
            font=root/next(iter(exporter.BUNDLED_BINARY_FILES))
            font.parent.mkdir(parents=True);font.write_bytes(b'\x00\x01\xff')
            self.assertEqual(len(exporter.audit(root,[source,font])),2)

    def test_public_audit_rejects_symlinks(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory).resolve()
            target=root/'source.py';target.write_text('pass\n')
            link=root/'link.py';link.symlink_to(target)
            with self.assertRaisesRegex(ValueError,'regular file'):
                exporter.audit(root,[link])

    def test_ignore_rules_protect_inputs_without_hiding_source(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory).resolve()
            subprocess.run(['git','init','-q',str(root)],check=True)
            (root/'.gitignore').write_text(exporter.PORTABLE_IGNORE)
            ignored=['.env','.env.local','.cdsapirc','nested/credentials.json',
                     'private/trip.json','trips/holiday.json','tracks/flight.csv',
                     'preview-site/trip.json','trip.json','data/earth.jpg',
                     'renders/video.mp4','nested/photo.heic','nested/model.glb',
                     'nested/state.npz','nested/flight.gpx','dist/release.tar.gz']
            visible=['README.md','tests/test_trip.py',str(exporter.SKILL/'examples/sample-single-leg.json'),
                     next(iter(exporter.BUNDLED_BINARY_FILES))]
            for name in ignored+visible:
                with self.subTest(name=name):
                    result=subprocess.run(['git','-c','core.excludesFile='+os.devnull,
                                           '-C',str(root),'check-ignore','-q',name])
                    self.assertEqual(result.returncode,0 if name in ignored else 1)

    def test_tracked_check_rejects_force_added_files_outside_allowlist(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory).resolve()
            subprocess.run(['git','init','-q',str(root)],check=True)
            subprocess.run(['git','-C',str(root),'config','core.excludesFile',os.devnull],check=True)
            source=root/'README.md';source.write_text('Route Replay\n')
            (root/'.gitignore').write_text(exporter.PORTABLE_IGNORE)
            subprocess.run(['git','-C',str(root),'add','README.md','.gitignore'],check=True)
            self.assertEqual(set(exporter.tracked_files(root,[source])),{source,root/'.gitignore'})
            (root/'.gitignore').write_text('')
            with self.assertRaisesRegex(ValueError,'portable ignore rules'):
                exporter.tracked_files(root,[source])
            (root/'.gitignore').write_text(exporter.PORTABLE_IGNORE)
            private=root/'private/itinerary.json';private.parent.mkdir();private.write_text('{}')
            subprocess.run(['git','-C',str(root),'add','-f',str(private)],check=True)
            with self.assertRaisesRegex(ValueError,'private/itinerary.json'):
                exporter.tracked_files(root,[source])

    def test_missing_allowlisted_file_fails_before_export(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory).resolve()
            (root/'README.md').write_text('Portable renderer')
            skill=root/exporter.SKILL;skill.mkdir(parents=True)
            (skill/'SKILL.md').write_text('Skill instructions')
            with patch.object(exporter,'ROOT_FILES',('README.md','tests/test_required.py')):
                with self.assertRaisesRegex(ValueError,'tests/test_required.py'):
                    exporter.source_files(root)
                (root/'tests').mkdir()
                test=root/'tests/test_required.py';test.write_text('pass\n')
                self.assertIn(test.resolve(),exporter.source_files(root))


if __name__=='__main__':unittest.main()
