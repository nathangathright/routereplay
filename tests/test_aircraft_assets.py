"""Local GLB validation and actual Cycles import/shared-depth regression."""
from pathlib import Path
import copy
import hashlib
import io
import json
import os
import shutil
import struct
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

import numpy as np

SCRIPTS=Path(__file__).resolve().parents[1]/'skills/cinematic-flight-videos/scripts'
sys.path.insert(0,str(SCRIPTS))
from aircraft_assets import validate_aircraft_model, validate_model_metadata


def model_metadata():
    return {'length_m':50.,'wingspan_m':40.,'nose_axis':'+X','up_axis':'+Z',
            'source':{'url':'https://example.invalid/synthetic-aircraft',
                      'credit':'Generated regression fixture',
                      'license_url':'https://opensource.org/license/mit/',
                      'notes':'Synthetic cuboid aircraft, not measured geometry or an actual flight assignment.'}}


def write_synthetic_glb(path, mutate=None, extra_binary=b'', mutate_payload=None):
    """Three simple boxes, non-default source axes and an off-origin hierarchy."""
    vertices=[];indices=[]
    for low,high in [((-.5,-5,-.5),(.5,5,.5)),((-4,-1.5,-.1),(4,0,.1)),
                     ((-.1,-4.5,0),(.1,-3,2))]:
        offset=len(vertices)
        for x,y,z in [(low[0],low[1],low[2]),(high[0],low[1],low[2]),
                      (high[0],high[1],low[2]),(low[0],high[1],low[2]),
                      (low[0],low[1],high[2]),(high[0],low[1],high[2]),
                      (high[0],high[1],high[2]),(low[0],high[1],high[2])]:
            vertices.append((y,-x,z))  # Declared glTF nose +X, up +Z.
        for face in [(0,3,2,1),(4,5,6,7),(0,1,5,4),(1,2,6,5),(2,3,7,6),(3,0,4,7)]:
            indices.extend(offset+i for i in (face[0],face[1],face[2],face[0],face[2],face[3]))
    positions=np.asarray(vertices,dtype='<f4'); triangles=np.asarray(indices,dtype='<u4')
    payload=positions.tobytes()+triangles.tobytes()+extra_binary
    if mutate_payload:
        payload=mutate_payload(payload)
    document={'asset':{'version':'2.0','generator':'Synthetic portable aircraft test'},
              'scene':0,'scenes':[{'nodes':[0,2,3]}],
              'nodes':[{'translation':[15,20,5],'children':[1]}, {'mesh':0},
                       {'camera':0}, {'extensions':{'KHR_lights_punctual':{'light':0}}}],
              'cameras':[{'type':'perspective','perspective':{'yfov':.5,'znear':.01,'zfar':100}}],
              'extensionsUsed':['KHR_lights_punctual'],
              'extensions':{'KHR_lights_punctual':{'lights':[{'type':'directional','intensity':1e6}]}},
              'meshes':[{'primitives':[{'attributes':{'POSITION':0},'indices':1,'material':0}]}],
              'materials':[{'pbrMetallicRoughness':{'baseColorFactor':[.65,.2,.05,1],
                                                  'metallicFactor':0,'roughnessFactor':.6}}],
              'buffers':[{'byteLength':len(payload)}],
              'bufferViews':[{'buffer':0,'byteOffset':0,'byteLength':positions.nbytes,'target':34962},
                             {'buffer':0,'byteOffset':positions.nbytes,'byteLength':triangles.nbytes,'target':34963}],
              'accessors':[{'bufferView':0,'componentType':5126,'count':len(positions),'type':'VEC3',
                            'min':positions.min(axis=0).tolist(),'max':positions.max(axis=0).tolist()},
                           {'bufferView':1,'componentType':5125,'count':len(triangles),'type':'SCALAR'}]}
    if mutate:
        mutate(document)
    encoded=json.dumps(document,separators=(',',':')).encode();encoded+=b' '*((-len(encoded))%4)
    payload+=b'\0'*((-len(payload))%4)
    content=struct.pack('<4sII',b'glTF',2,28+len(encoded)+len(payload))
    content+=struct.pack('<I4s',len(encoded),b'JSON')+encoded
    content+=struct.pack('<I4s',len(payload),b'BIN\0')+payload
    Path(path).write_bytes(content)
    record=model_metadata()
    record.update(path='aircraft-models/'+hashlib.sha256(content).hexdigest()+'.glb',
                  bytes=len(content),sha256=hashlib.sha256(content).hexdigest())
    return record


class AircraftAssetTests(unittest.TestCase):
    def test_dimensions_axes_and_attribution_are_required(self):
        valid=model_metadata()
        self.assertEqual(validate_model_metadata(valid),valid)
        for key,value in [('length_m',0),('wingspan_m',True),('up_axis','-X'),
                          ('nose_axis','north'),('source',{}),('extra',1),('length_m',float('nan'))]:
            with self.subTest(key=key,value=value):
                invalid=copy.deepcopy(valid);invalid[key]=value
                with self.assertRaises(ValueError):validate_model_metadata(invalid)

    def test_static_embedded_glb_and_hash(self):
        with tempfile.TemporaryDirectory() as temporary:
            path=Path(temporary)/'plane.glb';record=write_synthetic_glb(path)
            self.assertEqual(validate_aircraft_model(path,record),model_metadata())
            record['sha256']='0'*64
            with self.assertRaisesRegex(ValueError,'hash'):validate_aircraft_model(path,record)

    def test_external_resources_and_animation_are_rejected(self):
        mutations=[lambda d:d.update(images=[{'uri':'https://example.invalid/texture.png'}]),
                   lambda d:d['buffers'][0].update(uri='../outside.bin'),
                   lambda d:d.update(animations=[{}]),lambda d:d.update(skins=[{}]),
                   lambda d:d['meshes'][0]['primitives'][0].update(targets=[{}]),
                   lambda d:d.update(asset=[])]
        with tempfile.TemporaryDirectory() as temporary:
            path=Path(temporary)/'plane.glb'
            for index,mutate in enumerate(mutations):
                with self.subTest(case=index):
                    record=write_synthetic_glb(path,mutate)
                    with self.assertRaises(ValueError):validate_aircraft_model(path,record)

    def test_truncated_glb_is_rejected(self):
        with tempfile.TemporaryDirectory() as temporary:
            path=Path(temporary)/'plane.glb';write_synthetic_glb(path)
            path.write_bytes(path.read_bytes()[:-8])
            with self.assertRaisesRegex(ValueError,'complete'):validate_aircraft_model(path,model_metadata())

    def test_buffer_views_accessors_and_indices_cannot_escape_storage(self):
        mutations=[lambda d:d['bufferViews'][0].update(byteOffset=d['buffers'][0]['byteLength']),
                   lambda d:d['bufferViews'][0].update(buffer=1),
                   lambda d:d['bufferViews'][0].update(byteStride=8),
                   lambda d:d['accessors'][0].update(byteOffset=4),
                   lambda d:d['accessors'][0].update(bufferView=99),
                   lambda d:d['accessors'][0].update(sparse={}),
                   lambda d:d['accessors'][0].update(count=True)]
        with tempfile.TemporaryDirectory() as temporary:
            path=Path(temporary)/'plane.glb'
            for index,mutate in enumerate(mutations):
                with self.subTest(case=index):
                    record=write_synthetic_glb(path,mutate)
                    with self.assertRaises(ValueError):validate_aircraft_model(path,record)
            # This invalid index is inside the binary buffer, but outside the
            # primitive's POSITION vertex array. Do not defer it to Blender.
            record=write_synthetic_glb(path,mutate_payload=lambda raw:raw[:288]+struct.pack('<I',999)+raw[292:])
            with self.assertRaisesRegex(ValueError,'triangle index'):
                validate_aircraft_model(path,record)

    def test_declared_and_repeated_allocation_budgets_are_bounded(self):
        mutations=[lambda d:d['accessors'][0].update(count=6_000_001),
                   lambda d:d.update(accessors=[d['accessors'][0]]*257)]
        with tempfile.TemporaryDirectory() as temporary:
            path=Path(temporary)/'plane.glb'
            for mutate in mutations:
                record=write_synthetic_glb(path,mutate)
                with self.assertRaises(ValueError):validate_aircraft_model(path,record)
            # A small shared buffer cannot request many separate expanded
            # accessor allocations merely by aliasing its bytes repeatedly.
            def aliases(d):
                d['bufferViews'][0].update(byteOffset=720,byteLength=600_000)
                d['accessors'][0].update(count=50_000)
                d['accessors']=[d['accessors'][0]]*256
            record=write_synthetic_glb(path,aliases,extra_binary=b'\0'*600_000)
            with self.assertRaisesRegex(ValueError,'allocation'):
                validate_aircraft_model(path,record)
            # Reusing a POSITION accessor across primitives also creates mesh
            # work; count its vertices every time, not only once per accessor.
            def repeated(d):
                d['bufferViews'][0].update(byteOffset=720,byteLength=120_000)
                d['accessors'][0].update(count=10_000)
                d['meshes'][0]['primitives']*=201
            record=write_synthetic_glb(path,repeated,extra_binary=b'\0'*120_000)
            with self.assertRaisesRegex(ValueError,'two million'):
                validate_aircraft_model(path,record)

    def test_supported_extensions_are_explicit(self):
        with tempfile.TemporaryDirectory() as temporary:
            path=Path(temporary)/'plane.glb'
            for extension in ('KHR_draco_mesh_compression','EXT_meshopt_compression','KHR_texture_basisu','EXT_mesh_gpu_instancing'):
                record=write_synthetic_glb(path,lambda d:d.update(extensionsRequired=[extension]))
                with self.assertRaisesRegex(ValueError,'unsupported extensions'):
                    validate_aircraft_model(path,record)
            record=write_synthetic_glb(path,lambda d:d['meshes'][0]['primitives'][0].update(
                extensions={'KHR_draco_mesh_compression':{'bufferView':0}}))
            with self.assertRaisesRegex(ValueError,'unsupported extension'):
                validate_aircraft_model(path,record)
            record=write_synthetic_glb(path,lambda d:d.update(extensionsRequired=['KHR_materials_unlit']))
            validate_aircraft_model(path,record)

    def test_embedded_images_have_byte_dimension_and_aggregate_limits(self):
        from PIL import Image
        def image_record(d,raw,mime,count=1):
            d['bufferViews'].append({'buffer':0,'byteOffset':720,'byteLength':len(raw)})
            d['images']=[{'bufferView':2,'mimeType':mime} for _ in range(count)]
        with tempfile.TemporaryDirectory() as temporary:
            path=Path(temporary)/'plane.glb'
            for format,mime in [('PNG','image/png'),('JPEG','image/jpeg')]:
                output=io.BytesIO();Image.new('RGB',(8,8)).save(output,format=format);raw=output.getvalue()
                record=write_synthetic_glb(path,lambda d:image_record(d,raw,mime),extra_binary=raw)
                validate_aircraft_model(path,record)
                with patch('aircraft_assets.MAX_IMAGE_BYTES',32):
                    with self.assertRaisesRegex(ValueError,'8 MiB'):
                        validate_aircraft_model(path,record)
            # Header checks reject a decode bomb without allocating any pixels.
            oversized=b'\x89PNG\r\n\x1a\n'+struct.pack('>I4sII',13,b'IHDR',100_000,100_000)+b'\x08\x02\0\0\0'+b'\0'*4
            record=write_synthetic_glb(path,lambda d:image_record(d,oversized,'image/png'),extra_binary=oversized)
            with self.assertRaisesRegex(ValueError,'4096'):
                validate_aircraft_model(path,record)
            bounded=oversized[:16]+struct.pack('>II',4096,4096)+oversized[24:]
            record=write_synthetic_glb(path,lambda d:image_record(d,bounded,'image/png',5),extra_binary=bounded)
            with self.assertRaisesRegex(ValueError,'aggregate'):
                validate_aircraft_model(path,record)
            record=write_synthetic_glb(path,lambda d:d.update(images=[{'uri':'data:image/png;base64,'+'A'*1000}]))
            with self.assertRaisesRegex(ValueError,'data and external URIs'):
                validate_aircraft_model(path,record)

    def test_cyclic_node_hierarchy_is_rejected(self):
        with tempfile.TemporaryDirectory() as temporary:
            path=Path(temporary)/'plane.glb'
            record=write_synthetic_glb(path,lambda d:d['nodes'][1].update(children=[0]))
            with self.assertRaisesRegex(ValueError,'cyclic'):
                validate_aircraft_model(path,record)

    def test_actual_cycles_import_keeps_material_orientation_and_shared_depth(self):
        blender=shutil.which('blender')
        mac=Path('/Applications/Blender.app/Contents/MacOS/Blender')
        if blender is None and mac.is_file():blender=str(mac)
        if blender is None:self.skipTest('Blender not installed; GLB validation still runs')
        with tempfile.TemporaryDirectory(prefix='flight-imported-aircraft-') as temporary:
            root=Path(temporary);model=root/'synthetic.glb';record=write_synthetic_glb(model)
            metadata=root/'asset.json';metadata.write_text(json.dumps(record))
            samples=[{'frame':i,'heading':90*i,'sun_camera':[0,0,1], 'sun_visibility':1-i,
                      't':float(i),'camera_distance_earth':1.95,'aircraft_altitude_m':11000.,
                      'rendered_altitude_m':132000.,'vertical_exaggeration':12.,
                      'illustrative_altitude_m':11000.} for i in range(2)]
            (root/'lighting-samples.json').write_text(json.dumps(samples))
            command=[blender,'-b','-t','2','--python-exit-code','1','--python',
                     str(SCRIPTS/'engine/aircraft_blender.py'),'--','--a321neo','--all',
                     '--start','0','--end','2','--threads','2','--asset-model',str(model),
                     '--asset-metadata',str(metadata)]
            result=subprocess.run(command,env=dict(os.environ,FLIGHT_AIRCRAFT_DIR=temporary,
                                                   FLIGHT_QUALITY='preview'),
                                  capture_output=True,text=True,timeout=120)
            self.assertEqual(result.returncode,0,result.stdout+result.stderr)
            source=json.loads((root/'source-a321neo.json').read_text())
            self.assertEqual(source['asset_record']['sha256'],record['sha256'])
            self.assertAlmostEqual(source['imported_geometry']['wingspan_m'],40.,places=4)
            self.assertAlmostEqual(source['imported_geometry']['length_m'],50.,places=4)
            self.assertEqual(source['imported_geometry']['excluded_scene_objects'],{'cameras':1,'lights':1})
            self.assertNotIn('manufacturer_dimensions',source)
            energy=[];footprints=[]
            for i in range(2):
                with np.load(root/'frames-a321neo'/f'frame-{i:04d}.npz') as frame:
                    self.assertEqual(int(frame['schema_version']),2)
                    self.assertGreater(float(frame['ground_clearance_m']),0)
                    self.assertGreater(float(frame['model_camera_height_m']),50)
                    light,alpha,depth=frame['radiance'],frame['alpha'][...,0],frame['depth']
                    covered=alpha>.9
                    self.assertEqual(light.shape,(384,384,3))
                    self.assertTrue(np.isfinite(depth[alpha>0]).all())
                    self.assertTrue(np.all(depth[alpha>0]>0))
                    self.assertTrue(np.isinf(depth[alpha==0]).all())
                    self.assertTrue(np.isfinite(light).all())
                    self.assertGreater(float(light[covered,0].mean()),float(light[covered,2].mean())*2)
                    energy.append(float(light.sum()))
                    yy,xx=np.where(covered);footprints.append((int(np.ptp(xx)),int(np.ptp(yy))))
                    self.assertLess(abs(float(xx.mean())-191.5),25)
                    focal=1080/(2*np.tan(np.radians(35)))*(384/224)
                    y,x=np.mgrid[:384,:384]
                    cosine=1/np.sqrt(1+((x+.5-192)/focal)**2+((y+.5-192)/focal)**2)
                    heights=((1.95-depth*cosine)-1)*6371000-132000
                    self.assertGreater(float(heights[covered].min()),-.5)
                    heights-=float(frame['ground_clearance_m'])*12
                    self.assertLess(float(np.abs(heights[covered]).max()),80)
                    self.assertGreater(float(heights[covered].max()),40)
            self.assertLess(footprints[0][0],footprints[0][1])
            self.assertGreater(footprints[1][0],footprints[1][1])
            self.assertGreater(energy[0],energy[1]*1.5)


if __name__=='__main__':unittest.main()
