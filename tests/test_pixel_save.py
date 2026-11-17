import base64
import json
from pathlib import Path
from unittest.mock import patch

from test_bridge import CatalogTests, bridge
from fixture import png


class PixelSaveTests(CatalogTests):
    # Reuse only fixture setup/helpers, not inherited metadata test cases below.
    def save_pixels(self, iid=1, batch='pixel-test', **overrides):
        self.require_exiftool()
        self.settings['writeMode'] = 'embedded'
        source = Path(self.call('photo', id=iid)['path'])
        rendered = self.directory / 'rendered.png'
        png(rendered, width=80, height=50, seed=3)
        args = dict(id=iid, expectedHash=bridge.digest(source), data=base64.b64encode(rendered.read_bytes()).decode(), width=80, height=50, recipe={'auto': 100}, batch=batch)
        args.update(overrides)
        return self.call('save-pixels', **args)

    def test_save_preserves_metadata_dimensions_and_restores_exact_original(self):
        self.settings['writeMode'] = 'embedded'
        self.write({'addTags': ['Archive/Keep'], 'rating': 5, 'caption': 'Keep this caption'})
        source = Path(self.call('photo', id=1)['path']); before = source.read_bytes()
        result = self.save_pixels()
        self.assertNotEqual(source.read_bytes(), before)
        disk = json.loads(bridge.exif(self.require_exiftool(), ['-j', str(source)]))[0]
        self.assertEqual(disk['ImageWidth'], 80); self.assertEqual(disk['ImageHeight'], 50)
        self.assertIn('Archive/Keep', disk['TagsList'])
        self.assertEqual(disk['Rating'], 5); self.assertEqual(disk['Description'], 'Keep this caption')
        self.assertEqual(self.call('photo', id=1)['width'], 80)
        self.assertEqual(self.call('pixel-state')['1']['operation'], result['operation'])
        undone = self.call('undo-pixels', id=1)
        self.assertEqual(undone['ids'], [1]); self.assertEqual(source.read_bytes(), before)
        self.assertEqual(self.call('photo', id=1)['width'], 640)
        self.assertEqual(self.call('pixel-state'), {})
        self.assertEqual(self.write({'rating': 4})['errors'], [])

    def test_save_refuses_stale_source_and_wrong_encoding(self):
        source = Path(self.call('photo', id=1)['path']); before = source.read_bytes()
        with self.assertRaisesRegex(ValueError, 'original changed'):
            self.save_pixels(expectedHash='stale')
        with self.assertRaisesRegex(ValueError, 'dimensions'):
            self.save_pixels(width=900)
        self.assertEqual(source.read_bytes(), before)
        self.assertEqual(self.call('pixel-state'), {})

    def test_save_detects_race_before_replace(self):
        source = Path(self.call('photo', id=1)['path'])
        original = bridge.Catalog.copy_rendered_metadata
        def change_source(cat, photo, src, *args):
            original(cat, photo, src, *args)
            Path(src).write_bytes(Path(src).read_bytes() + b'external-change')
        with patch.object(bridge.Catalog, 'copy_rendered_metadata', change_source):
            with self.assertRaisesRegex(ValueError, 'original changed'):
                self.save_pixels()
        self.assertTrue(source.read_bytes().endswith(b'external-change'))

    def test_undo_batch_skips_external_changes_and_bad_backups(self):
        self.save_pixels(1); self.save_pixels(2)
        source = Path(self.call('photo', id=1)['path']); source.write_bytes(source.read_bytes() + b'external')
        result = self.call('undo-pixels')
        self.assertEqual(result['ids'], [2]); self.assertEqual(len(result['errors']), 1)
        self.assertTrue(source.read_bytes().endswith(b'external'))
        self.save_pixels(3, batch='another')
        record_path = next(p for p in self.data.glob('*/journal/*.json') if json.loads(p.read_text()).get('imageId') == 3)
        record = json.loads(record_path.read_text()); Path(record['backup']).write_bytes(b'broken')
        self.assertEqual(self.call('undo-pixels', id=3)['restored'], 0)

    def test_recover_interrupted_save_retains_operation_receipt(self):
        result = self.save_pixels()
        record_path = next(self.data.glob('*/journal/' + result['operation'] + '.json'))
        record = json.loads(record_path.read_text()); record['status'] = 'prepared'; bridge.atomic_json(record_path, record)
        self.call('recover')
        self.assertEqual(self.call('pixel-state')['1']['operation'], result['operation'])
        self.assertEqual(self.call('undo-pixels')['restored'], 1)


# Import fixture methods without running the complete parent suite twice.
for name in dir(CatalogTests):
    if name.startswith('test_') and name not in PixelSaveTests.__dict__:
        setattr(PixelSaveTests, name, None)
del CatalogTests
