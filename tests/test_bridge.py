import os
from contextlib import closing
import importlib.util
import json
from pathlib import Path
import sqlite3
import tempfile
import unittest

from fixture import fixture

spec = importlib.util.spec_from_file_location('bridge', Path(__file__).parents[1] / 'src/bridge.py')
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)


class CatalogTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.directory = Path(self.temp.name)
        self.settings = fixture(self.directory, count=4)
        self.data = self.directory / 'plugin-data'

    def tearDown(self):
        self.temp.cleanup()

    def call(self, action, **kwargs):
        return bridge.dispatch({'action': action, 'settings': self.settings, 'dataDir': str(self.data), **kwargs})

    def require_exiftool(self):
        try:
            return bridge.exiftool_path()
        except ValueError:
            self.skipTest('ExifTool is required for metadata integration tests')

    def read_xmp(self, image_id=1):
        path = self.directory / 'Collection' / f'Landscape-{image_id:02}.png.xmp'
        return json.loads(bridge.exif(self.require_exiftool(), ['-j', str(path)]))[0]

    def write(self, patch, ids=None):
        self.require_exiftool()
        return self.call('write', ids=ids or [1], patch=patch, batch='test-batch')

    def test_external_database_settings_cannot_select_a_photo_source(self):
        settings = {**self.settings, 'photoFolder': '', 'sourceMode': 'digikam'}
        with self.assertRaisesRegex(ValueError, 'photo folder'):
            bridge.dispatch({'action': 'catalog', 'settings': settings, 'dataDir': str(self.data)})

    def test_counts_deduplicate_ancestors_and_follow_pending_metadata(self):
        conn = sqlite3.connect(self.settings['databasePath'])
        conn.execute('INSERT INTO ImageTags VALUES (1,2)')
        conn.commit(); conn.close()
        catalog = self.call('catalog')
        self.assertEqual(catalog['tagCounts']['Places'], 2)
        self.assertEqual(catalog['tagCounts']['Places/Oregon/Coast'], 2)
        self.assertEqual(catalog['folderCounts'][os.path.normcase(str((self.directory / 'Collection').resolve()))], 4)
        self.write({'removeTags': ['Places', 'Places/Oregon/Coast'], 'addTags': ['New/Child']})
        catalog = self.call('catalog')
        self.assertEqual(catalog['tagCounts']['Places'], 1)
        self.assertEqual(catalog['tagCounts']['New'], 1)

    def test_folder_absolute_query_includes_descendants_and_not_nearby_names(self):
        root = self.directory / 'Collection'
        self.assertEqual(len(self.call('query', filters={'folderAbsolute': str(root)})['photos']), 4)
        self.assertEqual(len(self.call('query', filters={'folderAbsolute': str(root.parent)})['photos']), 4)
        self.assertEqual(len(self.call('query', filters={'folderAbsolute': str(root) + '-other'})['photos']), 0)
        (root / 'Nested').mkdir()
        self.call('file-operation', id=1, operation='move', destination=str(root / 'Nested' / 'renamed.png'))
        self.assertEqual([p['id'] for p in self.call('query', filters={'folderAbsolute': str(root / 'Nested')})['photos']], [1])
        self.assertEqual(self.call('catalog')['folderCounts'][os.path.normcase(str((root / 'Nested').resolve()))], 1)

    def test_folder_scan_keeps_valid_metadata_when_one_photo_is_broken(self):
        tool = self.require_exiftool()
        root = self.directory / 'Collection'
        self.settings.update(sourceMode='folder', photoFolder=str(root), databasePath='', rootMappings={}, writeMode='embedded')
        bridge.exif(tool, ['-overwrite_original', '-XMP-dc:Subject=Adventure', str(root / 'Landscape-01.png')])
        (root / 'broken.jpg').write_bytes(bytes(range(256)))
        result = self.call('scan')
        self.assertEqual(result['count'], 4)
        self.assertEqual(result['tagCounts']['Adventure'], 1)
        self.assertEqual(result['scanReport']['failed'], 1)
        self.assertIn('broken.jpg', result['scanReport']['errors'][0])
        result = self.call('scan')
        self.assertEqual(result['scanReport']['unchanged'], 4)
        self.assertEqual(result['scanReport']['failed'], 1)
        (root / 'broken.jpg').unlink()
        self.assertEqual(self.call('scan')['scanReport']['failed'], 0)

    def test_batch_tag_delete_deduplicates_photos_preserves_unrelated_tags_and_undo(self):
        self.write({'addTags': ['Review/A', 'Review/A/Child', 'Review/B', 'Keep']}, ids=[1, 2])
        selected = ['Review/A', 'Review/A/Child', 'Review/B']
        ids = self.call('tag-ids', tags=selected, descendants=True)
        self.assertEqual(ids, [1, 2])
        result = self.call('write', ids=ids, patch={}, batch='multi-delete', tagChange={'from': selected[0], 'fromTags': selected, 'to': None, 'descendants': True})
        self.assertEqual(len(result['successes']), 2)
        self.assertEqual(result['errors'], [])
        for iid in ids:
            tags = self.call('photo', id=iid)['tags']
            self.assertIn('Keep', tags)
            self.assertFalse(any(t.startswith('Review/') for t in tags))
        self.assertEqual(self.call('undo')['restored'], 2)
        self.assertIn('Review/A/Child', self.call('photo', id=1)['tags'])
        self.call('write', ids=ids, patch={}, batch='exact-delete', tagChange={'from': 'Review/A', 'fromTags': ['Review/A', 'Review/B'], 'to': None, 'descendants': False})
        self.assertIn('Review/A/Child', self.call('photo', id=1)['tags'])
        self.assertNotIn('Review/A', self.call('photo', id=1)['tags'])

    def test_folder_grouping_is_depth_first_and_stable_across_pages(self):
        conn = sqlite3.connect(self.settings['databasePath'])
        for aid, folder in [(2, '/A'), (3, '/A/Nested'), (4, '/A-sibling')]:
            conn.execute('INSERT INTO Albums VALUES (?,1,?)', (aid, folder))
        # IDs intentionally disagree with the hierarchy and filename order.
        conn.execute('UPDATE Images SET album=4 WHERE id=1')
        conn.execute('UPDATE Images SET album=2 WHERE id=2')
        conn.execute('UPDATE Images SET album=3 WHERE id=3')
        conn.commit(); conn.close()
        filters = {'folderAbsolute': str(self.directory / 'Collection'), 'folderRecursive': True, 'groupFolders': True, 'sort': 'name'}
        first = self.call('query', filters={**filters, 'limit': 2})
        second = self.call('query', filters={**filters, 'limit': 2, 'offset': 2})
        self.assertTrue(first['hasMore'])
        self.assertFalse(second['hasMore'])
        self.assertEqual([p['id'] for p in first['photos'] + second['photos']], [4, 2, 3, 1])
        direct = self.call('query', filters={**filters, 'folderRecursive': False})['photos']
        self.assertEqual([p['id'] for p in direct], [4])
        subfolder = {**filters, 'folderAbsolute': str(self.directory / 'Collection' / 'A')}
        self.assertEqual([p['id'] for p in self.call('query', filters=subfolder)['photos']], [2, 3])
        self.assertEqual([p['id'] for p in self.call('query', filters={**subfolder, 'folderRecursive': False})['photos']], [2])

    def test_unicode_and_multiline_metadata_survives_argument_transport(self):
        caption = 'Texte français, 日本語, 😀\nSecond line with \\ and # -overwrite_original'
        result = self.write({'caption': caption, 'addTags': ['日本語/Été']})
        self.assertEqual(result['errors'], [])
        xmp = self.read_xmp()
        self.assertEqual(xmp['Description'], caption)
        self.assertIn('日本語/Été', xmp['TagsList'])

    def test_pagination_hierarchy_and_internal_labels(self):
        self.assertEqual(self.call('catalog')['tags'], ['Places', 'Places/Oregon', 'Places/Oregon/Coast', 'Portfolio'])
        self.assertEqual(len(self.call('query', filters={'tag': 'Places'})['photos']), 2)
        self.assertEqual(len(self.call('query', filters={'tag': 'Places', 'descendants': False})['photos']), 0)
        first = self.call('query', filters={'limit': 2, 'ascending': True})
        self.assertEqual([p['id'] for p in first['photos']], [1, 2])
        self.assertTrue(first['hasMore'])
        labeled = self.call('query', filters={'color': '5', 'pick': '3'})['photos']
        self.assertEqual([p['id'] for p in labeled], [3])

    def test_readonly_reader_observes_wal_without_changing_main(self):
        writer = sqlite3.connect(self.settings['databasePath'])
        writer.execute('PRAGMA journal_mode=WAL')
        writer.execute("UPDATE Images SET name='100% real.png' WHERE id=1")
        writer.commit()
        before = bridge.digest(self.settings['databasePath'])
        self.assertEqual(len(self.call('query', filters={'search': '%'})['photos']), 1)
        self.assertEqual(before, bridge.digest(self.settings['databasePath']))
        cat = bridge.Catalog(bridge.folder_request({'settings': self.settings, 'dataDir': str(self.data)}))
        with self.assertRaises(sqlite3.OperationalError):
            cat.conn.execute('DELETE FROM main.Images')
        cat.conn.close()
        writer.close()

    def test_sidecar_roundtrip_preserves_original_and_catalog_tags(self):
        source = self.directory / 'Collection/Landscape-01.png'
        before = bridge.digest(source)
        result = self.write({'addTags': ['Projects/Book'], 'rating': 5, 'color': 2, 'pick': 3})
        self.assertEqual(result['errors'], [])
        self.assertEqual(bridge.digest(source), before)
        xmp = self.read_xmp()
        self.assertEqual(set(bridge.listify(xmp['TagsList'])), {'Projects/Book', 'Places/Oregon/Coast'})
        self.assertEqual(set(bridge.listify(xmp['HierarchicalSubject'])), {'Projects|Book', 'Places|Oregon|Coast'})
        self.assertEqual(xmp['Rating'], 5)
        self.assertEqual(str(xmp['ColorLabel']), '2')
        self.assertEqual(str(xmp['PickLabel']), '3')
        self.assertEqual(xmp['Description'], 'Original landscape 1')
        self.assertEqual([p['id'] for p in self.call('query', filters={'tag': 'Projects', 'rating': '5'})['photos']], [1])
        self.assertEqual(self.call('undo')['restored'], 1)
        self.assertFalse(Path(str(source) + '.xmp').exists())

    def test_remove_tag_survives_stale_database_and_restart(self):
        self.assertEqual(self.write({'addTags': ['Projects/Book']})['errors'], [])
        self.assertEqual(self.write({'removeTags': ['Places/Oregon/Coast']})['errors'], [])
        self.call('recover')
        photo = self.call('photo', id=1)
        self.assertEqual(photo['tags'], ['Projects/Book'])
        self.assertEqual([p['id'] for p in self.call('query', filters={'tag': 'Places'})['photos']], [3])

    def test_partial_batch_failure_and_external_conflict_are_visible(self):
        result = self.write({'rating': 4}, [1, 999])
        self.assertEqual(len(result['successes']), 1)
        self.assertEqual(len(result['errors']), 1)
        path = self.directory / 'Collection/Landscape-01.png.xmp'
        with path.open('ab') as file:
            file.write(b'\n<!-- external update -->\n')
        original = path.read_bytes()
        self.assertTrue(self.write({'rating': 3})['errors'])
        result = self.call('undo')
        self.assertEqual(result['restored'], 0)
        self.assertTrue(result['errors'])
        self.assertEqual(path.read_bytes(), original)

    def test_preserve_unrelated_sidecar_fields(self):
        self.write({'rating': 4})
        self.call('release', ids=[1])
        path = self.directory / 'Collection/Landscape-01.png.xmp'
        bridge.exif(self.require_exiftool(), ['-overwrite_original', '-XMP-dc:Rights=Photographer copyright', '-XMP-dc:Description-fr=Texte français', str(path)])
        self.assertEqual(self.write({'addTags': ['Portfolio']})['errors'], [])
        xmp = self.read_xmp()
        self.assertEqual(xmp['Rights'], 'Photographer copyright')
        self.assertEqual(xmp['Description-fr'], 'Texte français')

    def test_recover_committed_file_after_interrupted_journal_update(self):
        self.write({'rating': 5})
        record_path = next(self.data.glob('*/journal/*.json'))
        record = json.loads(record_path.read_text())
        record['status'] = 'prepared'
        record_path.write_text(json.dumps(record))
        next(self.data.glob('*/pending.json')).unlink()
        self.call('recover')
        self.assertEqual(self.call('photo', id=1)['rating'], 5)
        self.assertEqual(json.loads(record_path.read_text())['status'], 'committed')

    def test_ambiguous_stem_sidecars_are_rejected(self):
        self.settings['sidecarNaming'] = 'stem'
        (self.directory / 'Collection/Landscape-01.raw').write_bytes(b'raw')
        result = self.write({'rating': 5})
        self.assertIn('shares this filename stem', result['errors'][0]['error'])

    def test_path_escape_and_disabled_writes_are_rejected(self):
        writer = sqlite3.connect(self.settings['databasePath'])
        writer.execute("UPDATE Albums SET relativePath='/../../' WHERE id=1")
        writer.commit(); writer.close()
        with self.assertRaisesRegex(ValueError, 'escapes'):
            self.call('photo', id=1)
        self.settings['writesEnabled'] = False
        with self.assertRaisesRegex(ValueError, 'Enable metadata writing'):
            self.call('write', ids=[1], patch={'rating': 1}, batch='x')

    def test_export_preserves_catalog_metadata_and_normalizes_dimensions(self):
        self.require_exiftool()
        from fixture import png
        exported = self.directory / 'exports'
        exported.mkdir()
        output = exported / 'edited.png'
        png(output, 320, 200)
        result = self.call('export-metadata', id=1, outputPath=str(output), exportRoot=str(exported), width=320, height=200)
        self.assertTrue(result['saved'])
        data = json.loads(bridge.exif(self.require_exiftool(), ['-j', str(output)]))[0]
        self.assertEqual(data['ImageWidth'], 320)
        self.assertEqual(data['ImageHeight'], 200)
        self.assertEqual(data['Rating'], 1)
        self.assertIn('Places/Oregon/Coast', bridge.listify(data['TagsList']))

    def test_existing_sidecar_rating_is_not_replaced_by_stale_catalog(self):
        self.write({'rating': 5})
        self.call('release', ids=[1])
        self.assertEqual(self.write({'addTags': ['Projects/Book']})['errors'], [])
        self.assertEqual(self.call('photo', id=1)['rating'], 5)
        self.assertEqual(self.read_xmp()['Rating'], 5)

    def test_embedded_metadata_can_be_restored_byte_for_byte(self):
        self.settings['writeMode'] = 'embedded'
        source = self.directory / 'Collection/Landscape-01.png'
        before = source.read_bytes()
        result = self.write({'rating': 5, 'addTags': ['Portfolio']})
        self.assertEqual(result['errors'], [])
        self.assertNotEqual(source.read_bytes(), before)
        self.assertEqual(self.call('undo')['restored'], 1)
        self.assertEqual(source.read_bytes(), before)

    def test_embedded_default_writes_labels_without_sidecar_or_pixel_changes(self):
        self.settings.pop('writeMode', None)
        source = self.directory / 'Collection/Landscape-01.png'
        def image_payload(data):
            chunks, offset = [], 8
            while offset < len(data):
                size = int.from_bytes(data[offset:offset + 4], 'big')
                if data[offset + 4:offset + 8] == b'IDAT':
                    chunks.append(data[offset + 8:offset + 8 + size])
                offset += size + 12
            return b''.join(chunks)
        pixels = image_payload(source.read_bytes())
        self.assertTrue(pixels)
        result = self.write({'rating': 5, 'color': 6, 'pick': 3, 'addTags': ['Projects/Print']})
        self.assertEqual(result['errors'], [])
        data = json.loads(bridge.exif(self.require_exiftool(), ['-j', str(source)]))[0]
        self.assertEqual(data['Rating'], 5)
        self.assertEqual(data['ColorLabel'], 6)
        self.assertEqual(data['PickLabel'], 3)
        self.assertIn('Projects/Print', bridge.listify(data['TagsList']))
        self.assertEqual(image_payload(source.read_bytes()), pixels)
        self.assertEqual(list(source.parent.glob('*.xmp')), [])

    def test_unsupported_embedded_format_never_falls_back_to_sidecar(self):
        self.settings['writeMode'] = 'embedded'
        source = self.directory / 'Collection/Landscape-01.png'
        renamed = source.with_suffix('.cr2')
        source.rename(renamed)
        with closing(sqlite3.connect(self.settings['databasePath'])) as db, db:
            db.execute('UPDATE Images SET name=? WHERE id=1', (renamed.name,))
        before = renamed.read_bytes()
        result = self.write({'rating': 5})
        self.assertEqual(len(result['errors']), 1)
        self.assertIn('no sidecar was created', result['errors'][0]['error'])
        self.assertEqual(renamed.read_bytes(), before)
        self.assertEqual(list(renamed.parent.glob('*.xmp')), [])

    def test_pending_sidecar_cannot_be_silently_replaced_by_embedded_state(self):
        self.write({'rating': 4})
        self.settings['writeMode'] = 'embedded'
        source = self.directory / 'Collection/Landscape-01.png'
        before = source.read_bytes()
        result = self.write({'rating': 5})
        self.assertEqual(len(result['errors']), 1)
        self.assertIn('different write destination', result['errors'][0]['error'])
        self.assertEqual(source.read_bytes(), before)
        self.assertEqual(self.read_xmp()['Rating'], 4)


if __name__ == '__main__':
    unittest.main()

class WorkflowTests(unittest.TestCase):
    setUp = CatalogTests.setUp
    tearDown = CatalogTests.tearDown
    call = CatalogTests.call
    require_exiftool = CatalogTests.require_exiftool
    write = CatalogTests.write
    def test_rename_and_delete_tags_across_whole_collection_with_undo(self):
        self.settings['writeMode'] = 'embedded'
        self.write({'addTags': ['Projects/Art/Paint', 'Other']}, [1, 2, 3])
        ids = self.call('tag-ids', tag='Projects/Art', descendants=True)
        self.assertEqual(set(ids), {1, 2, 3})
        change = {'from': 'Projects/Art', 'to': 'Projects/Adventure', 'descendants': True}
        result = self.call('write', ids=ids, patch={}, tagChange=change, batch='rename')
        self.assertEqual(result['errors'], [])
        self.assertEqual(self.call('tag-ids', tag='Projects/Art'), [])
        self.assertNotIn('Projects/Art', self.call('catalog')['tags'])
        self.assertIn('Other', self.call('photo', id=1)['tags'])
        self.assertIn('Projects/Adventure/Paint', self.call('photo', id=1)['tags'])
        self.assertEqual(self.call('undo')['restored'], 3)
        self.assertIn('Projects/Art/Paint', self.call('photo', id=1)['tags'])
        result = self.call('write', ids=ids, patch={}, tagChange={'from': 'Projects/Art', 'to': None, 'descendants': True}, batch='delete-tag')
        self.assertEqual(result['errors'], [])
        self.assertNotIn('Projects/Art/Paint', self.call('photo', id=1)['tags'])
        self.assertTrue((self.directory / 'Collection/Landscape-01.png').exists())

    def test_folder_index_rebuilds_from_embedded_metadata(self):
        self.require_exiftool()
        self.settings.update(sourceMode='folder', photoFolder=str(self.directory / 'Collection'), databasePath='', rootMappings={}, writeMode='embedded')
        self.assertEqual(self.call('scan')['count'], 4)
        photos = self.call('query', filters={})['photos']
        iid = photos[0]['id']
        result = self.write({'rating': 5, 'addTags': ['Art/Print']}, [iid])
        self.assertEqual(result['errors'], [])
        self.call('scan')
        self.call('release', ids=[iid])
        self.assertEqual(self.call('photo', id=iid)['rating'], 5)
        self.assertIn('Art/Print', self.call('photo', id=iid)['tags'])
        self.assertIn('Art/Print', self.call('catalog')['tags'])
        path = Path(self.call('photo', id=iid)['path']); path.unlink()
        self.assertEqual(self.call('scan')['count'], 3)

    def test_move_preserves_metadata_undo_and_copy_never_overwrites(self):
        self.settings['writeMode'] = 'embedded'
        source = self.directory / 'Collection/Landscape-01.png'
        before = source.read_bytes()
        self.write({'rating': 5}, [1])
        destination = source.with_name('Renamed.png')
        self.call('file-operation', id=1, operation='move', destination=str(destination))
        self.assertFalse(source.exists())
        self.assertEqual(self.call('photo', id=1)['path'], str(destination.resolve()))
        self.assertEqual(self.call('photo', id=1)['name'], 'Renamed.png')
        self.assertEqual(self.call('undo')['restored'], 1)
        self.assertEqual(destination.read_bytes(), before)
        copy = destination.with_name('Copy.png')
        self.call('file-operation', id=1, operation='copy', destination=str(copy))
        self.assertEqual(copy.read_bytes(), before)
        with self.assertRaisesRegex(ValueError, 'already exists'):
            self.call('file-operation', id=1, operation='copy', destination=str(copy))

    def test_folder_move_keeps_id_and_deleted_file_can_be_restored(self):
        self.settings.update(sourceMode='folder', photoFolder=str(self.directory / 'Collection'), databasePath='', rootMappings={}, writeMode='embedded')
        self.call('scan')
        photo = self.call('query', filters={})['photos'][0]
        source = Path(photo['path']); dest = source.with_name('Moved.png'); iid = photo['id']
        self.call('file-operation', id=iid, operation='move', destination=str(dest))
        self.call('scan')
        self.assertEqual(self.call('photo', id=iid)['path'], str(dest.resolve()))
        self.assertEqual(self.call('catalog')['count'], 4)
        trash = self.directory / 'trash.png'; dest.rename(trash)
        self.call('file-deleted', id=iid)
        self.assertEqual(self.call('catalog')['count'], 3)
        trash.rename(dest)
        self.call('scan')
        self.assertEqual(self.call('catalog')['count'], 4)
        self.assertEqual(self.call('photo', id=iid)['path'], str(dest.resolve()))

    def test_folder_export_filter_includes_descendants_not_similar_prefixes(self):
        with closing(sqlite3.connect(self.settings['databasePath'])) as db, db:
            db.execute("UPDATE Albums SET relativePath='/Trip' WHERE id=1")
            db.execute("INSERT INTO Albums VALUES (2,1,'/Trip/Day')")
            db.execute("INSERT INTO Albums VALUES (3,1,'/Trips')")
            db.execute('UPDATE Images SET album=2 WHERE id=2')
            db.execute('UPDATE Images SET album=3 WHERE id=3')
        ids = {p['id'] for p in self.call('query', filters={'rootId':'1','folderPath':'/Trip'})['photos']}
        self.assertEqual(ids, {1,2,4})
        self.assertEqual(len(self.call('query', filters={'folderPath':'/'})['photos']), 4)

    def test_folder_scan_recovers_move_before_assigning_new_ids(self):
        self.settings.update(sourceMode='folder', photoFolder=str(self.directory / 'Collection'), databasePath='', rootMappings={}, writeMode='embedded')
        self.call('scan')
        photo = self.call('query', filters={})['photos'][0]
        source = Path(photo['path']); target = source.with_name('Interrupted.png')
        before = bridge.digest(source); source.rename(target)
        req = bridge.folder_request({'settings': self.settings, 'dataDir': str(self.data)})
        cat = bridge.Catalog(req)
        journal = cat.data / 'file-operations'; journal.mkdir(parents=True, exist_ok=True)
        bridge.atomic_json(journal / 'interrupted.json', {'id':photo['id'], 'operation':'move', 'pairs':[[str(source),str(target)]], 'hashes':{str(source):before}, 'status':'prepared'})
        cat.conn.close()
        self.call('scan')
        self.assertEqual(self.call('catalog')['count'], 4)
        self.assertEqual(self.call('photo', id=photo['id'])['path'], str(target))
