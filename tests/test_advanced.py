import hashlib
import importlib.util
import sqlite3
import tempfile
import unittest
from pathlib import Path
from fixture import fixture

src = Path(__file__).parents[1] / 'src'
spec = importlib.util.spec_from_file_location('advanced_bridge_test',src/'bridge.py')
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)
exec((src/'advanced.py').read_text(),bridge.__dict__)


class AdvancedTests(unittest.TestCase):
    def test_setup_status_needs_no_photo_folder_or_models(self):
        with tempfile.TemporaryDirectory() as directory:
            req = dict(action='advanced-status',feature='people',dataDir=directory,settings={})
            self.assertFalse(bridge.dispatch(req))
            req['action'] = 'advanced-results'
            with self.assertRaisesRegex(ValueError,'Set up'):
                bridge.dispatch(req)

    def test_duplicate_results_preserve_ids_tags_and_ratings(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            req = dict(action='advanced-results',feature='duplicates',dataDir=str(root/'plugin-data'),settings=fixture(root,count=3))
            cat = bridge.Catalog(bridge.folder_request(req))
            cat.data.mkdir(parents=True,exist_ok=True)
            marker = Path(req['dataDir'])/'advanced/duplicates.ready'
            marker.parent.mkdir(); marker.touch()
            self.assertEqual(bridge.dispatch(req),[])
            with sqlite3.connect(cat.data/'analysis-v1.sqlite') as db:
                for iid, pixels in [(1,'one'),(2,'one'),(3,'other')]:
                    db.execute('INSERT INTO items VALUES(?,?,?,?,?,?)',('duplicates',iid,cat.photo(iid)['path'],'stamp',pixels,'test'))
            group, = bridge.dispatch(req)
            self.assertEqual([item['id'] for item in group],[1,2])
            self.assertNotEqual(group[0]['rating'],group[1]['rating'])
            self.assertNotEqual(group[0]['tags'],group[1]['tags'])
            cat.conn.close()
