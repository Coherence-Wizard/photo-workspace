"""Local photo metadata helper. Browsing opens the rebuildable index mode=ro.

One JSON request on stdin, one JSON response on stdout. No shell execution.
The index and undo journal live in the plugin's local data directory.
"""
import base64
from contextlib import closing
import hashlib
import json
import os
from pathlib import Path
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import time
import uuid

COLORS = ['None', 'Red', 'Orange', 'Yellow', 'Green', 'Blue', 'Magenta', 'Gray', 'Black', 'White']
PICKS = ['None', 'Rejected', 'Pending', 'Accepted']
EDITABLE = {'rating', 'color', 'pick', 'title', 'caption', 'addTags', 'removeTags'}


def atomic_json(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(dir=path.parent, prefix='.photo-', suffix='.json')
    try:
        with os.fdopen(fd, 'w', encoding='utf-8') as f:
            json.dump(value, f, ensure_ascii=False)
            f.flush()
            os.fsync(f.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def digest(path):
    if not Path(path).exists():
        return None
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b''):
            h.update(chunk)
    return h.hexdigest()


def exiftool_path(configured=''):
    candidates = [configured] if configured else []
    candidates += [shutil.which('exiftool'), '/opt/homebrew/bin/exiftool', '/usr/local/bin/exiftool']
    for candidate in candidates:
        if candidate and Path(candidate).is_file():
            return str(Path(candidate).resolve())
    raise ValueError('ExifTool was not found. Install ExifTool or choose its executable in Coherence Photo settings.')


def run_exif(tool, args, timeout=90):
    # UTF-8 arguments on stdin avoid Windows command-line code-page conversion.
    # CSTR lines preserve literal backslashes and multiline captions as one argument.
    lines = []
    for argument in args:
        value = str(argument)
        if '\0' in value: raise ValueError('Metadata arguments cannot contain a null character.')
        value = value.replace('\\', '\\\\').replace('\n', '\\n').replace('\r', '\\r').replace('\t', '\\t')
        lines.append('#[CSTR]' + value)
    return subprocess.run([tool, '-charset', 'UTF8', '-charset', 'filename=UTF8', '-@', '-'],
                          input=('\n'.join(lines) + '\n').encode('utf-8'), capture_output=True, timeout=timeout)


def exif(tool, args, binary=False):
    result = run_exif(tool, args)
    if result.returncode:
        raise ValueError(result.stderr.decode('utf-8', 'replace').strip() or 'ExifTool could not process the file.')
    return result.stdout if binary else result.stdout.decode('utf-8', 'replace')


def read_photo_metadata(tool, paths):
    """ExifTool may return 1 with useful JSON plus per-file Error records."""
    fields = ['TagsList', 'HierarchicalSubject', 'Subject', 'Keywords', 'Rating', 'ColorLabel', 'PickLabel',
              'DateTimeOriginal', 'CreateDate', 'ImageWidth', 'ImageHeight', 'FileType', 'Model', 'LensModel',
              'Lens', 'Title', 'Description', 'GPSLatitude', 'GPSLongitude']
    result = run_exif(tool, ['-j', '-n', '-d', '%Y-%m-%dT%H:%M:%S',
                            *['-' + f for f in fields], '-Error', '-Warning', *map(str, paths)], timeout=120)
    try:
        records = json.loads(result.stdout)
        if not isinstance(records, list) or not records:
            raise ValueError('No metadata records returned')
    except (ValueError, TypeError) as error:
        raise ValueError('ExifTool could not read this batch: ' + result.stderr.decode('utf-8', 'replace').strip()) from error
    return records


def metadata_batches(tool, changed):
    # Keep only four batches in flight, regardless of collection size.
    from concurrent.futures import ThreadPoolExecutor
    from collections import deque
    def bounded_chunks():
        chunk, length = [], 0
        for entry in changed:
            size = len(str(entry[0]).encode('utf-16-le')) // 2 + 4
            if chunk and (len(chunk) >= 256 or length + size > 20000):
                yield chunk
                chunk, length = [], 0
            chunk.append(entry); length += size
        if chunk: yield chunk
    chunks = iter(bounded_chunks())
    with ThreadPoolExecutor(max_workers=4) as pool:
        pending = deque()
        def submit():
            chunk = next(chunks, None)
            if chunk is not None: pending.append((chunk, pool.submit(read_photo_metadata, tool, [p[0] for p in chunk])))
        for _ in range(4): submit()
        while pending:
            chunk, result = pending.popleft()
            yield chunk, result.result()
            submit()


def listify(value):
    if value is None:
        return []
    return value if isinstance(value, list) else [value]


PHOTO_EXTENSIONS = {'.jpg', '.jpeg', '.png', '.tif', '.tiff', '.webp', '.avif', '.heic', '.heif', '.gif', '.bmp', '.dng', '.cr2', '.cr3', '.nef', '.arw', '.orf', '.rw2', '.raf', '.pef'}


def folder_request(request, scan=False):
    """Index user-selected photos locally. This rebuildable index belongs to the plugin."""
    settings = dict(request.get('settings', {}))
    root = Path(settings.get('photoFolder', '')).expanduser().resolve()
    if not settings.get('photoFolder') or not root.is_dir():
        raise ValueError('Choose an existing photo folder in settings, then click Scan photos.')
    key = hashlib.sha256(str(root).encode()).hexdigest()[:24]
    directory = Path(request['dataDir']) / 'folder-indexes'
    directory.mkdir(parents=True, exist_ok=True)
    db = directory / (key + '.db')
    report = None
    if scan or not db.exists():
        tool = exiftool_path(settings.get('exiftoolPath', ''))
        conn = sqlite3.connect(db, timeout=30)
        try:
            conn.executescript('''
            CREATE TABLE IF NOT EXISTS Settings (keyword TEXT PRIMARY KEY, value TEXT);
            CREATE TABLE IF NOT EXISTS AlbumRoots (id INTEGER PRIMARY KEY,label TEXT,status INTEGER,type INTEGER,identifier TEXT,specificPath TEXT);
            CREATE TABLE IF NOT EXISTS Albums (id INTEGER PRIMARY KEY,albumRoot INTEGER,relativePath TEXT UNIQUE);
            CREATE TABLE IF NOT EXISTS Images (id INTEGER PRIMARY KEY AUTOINCREMENT,album INTEGER,name TEXT,status INTEGER,category INTEGER,fileSize INTEGER);
            CREATE TABLE IF NOT EXISTS ImageInformation (imageid INTEGER PRIMARY KEY,rating INTEGER,creationDate TEXT,width INTEGER,height INTEGER,format TEXT);
            CREATE TABLE IF NOT EXISTS ImageMetadata (imageid INTEGER PRIMARY KEY,model TEXT,lens TEXT);
            CREATE TABLE IF NOT EXISTS ImageComments (id INTEGER PRIMARY KEY,imageid INTEGER,type INTEGER,language TEXT,comment TEXT);
            CREATE TABLE IF NOT EXISTS ImagePositions (imageid INTEGER PRIMARY KEY,latitudeNumber REAL,longitudeNumber REAL);
            CREATE TABLE IF NOT EXISTS Tags (id INTEGER PRIMARY KEY,pid INTEGER,name TEXT,UNIQUE(pid,name));
            CREATE TABLE IF NOT EXISTS ImageTags (imageid INTEGER,tagid INTEGER,UNIQUE(imageid,tagid));
            CREATE TABLE IF NOT EXISTS FolderFiles (path TEXT PRIMARY KEY,imageid INTEGER,stamp TEXT);
            CREATE INDEX IF NOT EXISTS tags_by_image ON ImageTags(imageid);
            CREATE INDEX IF NOT EXISTS comments_by_image ON ImageComments(imageid);
            ''')
            conn.execute('BEGIN IMMEDIATE')
            conn.execute("INSERT OR REPLACE INTO Settings VALUES ('DBVersion','Photo Workspace folder index 1')")
            conn.execute('INSERT OR REPLACE INTO AlbumRoots VALUES (1,?,0,1,?,?)', (root.name, 'photo-workspace-folder:' + key, str(root)))
            def tag_id(path):
                parent = 0
                for part in path.split('/'):
                    if not part.strip():
                        continue
                    conn.execute('INSERT OR IGNORE INTO Tags(pid,name) VALUES (?,?)', (parent, part))
                    parent = conn.execute('SELECT id FROM Tags WHERE pid=? AND name=?', (parent, part)).fetchone()[0]
                return parent
            known = {p: (iid, stamp) for p, iid, stamp in conn.execute('SELECT path,imageid,stamp FROM FolderFiles')}
            seen, changed = set(), []
            for base, dirs, names in os.walk(root, followlinks=False):
                dirs[:] = [d for d in dirs if not d.startswith('.') and not (Path(base) / d).is_symlink()]
                for name in names:
                    path = Path(base) / name
                    if name.startswith('.') or path.suffix.lower() not in PHOTO_EXTENSIONS or path.is_symlink():
                        continue
                    rel = path.relative_to(root).as_posix()
                    stat = path.stat()
                    stamp = str(stat.st_mtime_ns) + ':' + str(stat.st_size)
                    sidecar = Path(str(path) + '.xmp') if settings.get('sidecarNaming', 'full') == 'full' else path.with_suffix('.xmp')
                    if settings.get('writeMode') == 'sidecar' and sidecar.is_file():
                        stamp += ':' + str(sidecar.stat().st_mtime_ns)
                    seen.add(rel)
                    if rel in known and known[rel][1] == stamp:
                        conn.execute('UPDATE Images SET status=1 WHERE id=?', (known[rel][0],))
                    else:
                        changed.append((path, rel, stamp, sidecar))
            errors = []
            read_count = 0
            processed = 0
            for chunk, records in metadata_batches(tool, changed):
                processed += len(chunk)
                by_path = {str(Path(m['SourceFile']).resolve()): m for m in records}
                for path, rel, stamp, sidecar in chunk:
                    m = by_path.get(str(path.resolve()), {})
                    if not m or m.get('Error'):
                        errors.append(rel + ': ' + str(m.get('Error', 'Metadata unavailable')))
                        continue
                    if settings.get('writeMode') == 'sidecar' and sidecar.is_file():
                        m.update(json.loads(exif(tool, ['-j', '-n', str(sidecar)]))[0])
                    album = '/' + path.parent.relative_to(root).as_posix().removeprefix('.')
                    conn.execute('INSERT OR IGNORE INTO Albums(albumRoot,relativePath) VALUES (1,?)', (album,))
                    aid = conn.execute('SELECT id FROM Albums WHERE relativePath=?', (album,)).fetchone()[0]
                    if rel in known:
                        iid = known[rel][0]
                        conn.execute('UPDATE Images SET album=?,name=?,status=1,fileSize=? WHERE id=?', (aid, path.name, path.stat().st_size, iid))
                    else:
                        iid = conn.execute('INSERT INTO Images(album,name,status,category,fileSize) VALUES (?,?,1,1,?)', (aid, path.name, path.stat().st_size)).lastrowid
                    def number(key, default=0):
                        try: return int(m.get(key, default))
                        except (TypeError, ValueError): return default
                    conn.execute('INSERT OR REPLACE INTO ImageInformation VALUES (?,?,?,?,?,?)', (iid, max(0, min(5, number('Rating'))), m.get('DateTimeOriginal', m.get('CreateDate')), number('ImageWidth'), number('ImageHeight'), m.get('FileType', path.suffix[1:].upper())))
                    conn.execute('INSERT OR REPLACE INTO ImageMetadata VALUES (?,?,?)', (iid, str(m.get('Model', '')), str(m.get('LensModel', m.get('Lens', '')))))
                    conn.execute('DELETE FROM ImageComments WHERE imageid=?', (iid,))
                    for kind, field in [(3, 'Title'), (1, 'Description')]:
                        conn.execute('INSERT INTO ImageComments(imageid,type,language,comment) VALUES (?,?,?,?)', (iid, kind, 'x-default', str(m.get(field, ''))))
                    conn.execute('INSERT OR REPLACE INTO ImagePositions VALUES (?,?,?)', (iid, m.get('GPSLatitude'), m.get('GPSLongitude')))
                    conn.execute('DELETE FROM ImageTags WHERE imageid=?', (iid,))
                    tags = {str(t).strip() for t in listify(m.get('TagsList')) if str(t).strip()} | {str(t).replace('|', '/') for t in listify(m.get('HierarchicalSubject'))}
                    leaves = {t.split('/')[-1] for t in tags}
                    tags.update(str(t).strip() for t in listify(m.get('Subject')) + listify(m.get('Keywords')) if str(t).strip() and str(t) not in leaves)
                    for field, prefix, names in [('ColorLabel', 'Color Label ', COLORS), ('PickLabel', 'Pick Label ', PICKS)]:
                        value = number(field)
                        if 0 < value < len(names): tags.add('_Digikam_Internal_Tags_/' + prefix + names[value])
                    for tag in tags:
                        conn.execute('INSERT OR IGNORE INTO ImageTags VALUES (?,?)', (iid, tag_id(tag)))
                    conn.execute('INSERT OR REPLACE INTO FolderFiles VALUES (?,?,?)', (rel, iid, stamp))
                    read_count += 1
                conn.commit()
                print('PW_PROGRESS ' + json.dumps({'processed': processed, 'total': len(changed), 'errors': len(errors)}), file=sys.stderr, flush=True)
                conn.execute('BEGIN IMMEDIATE')
            for rel, (iid, _) in known.items():
                if rel not in seen: conn.execute('UPDATE Images SET status=0 WHERE id=?', (iid,))
            conn.commit()
            report = {'found': len(seen), 'read': read_count, 'unchanged': len(seen) - len(changed), 'failed': len(errors), 'errors': errors[:20]}
            atomic_json(directory / (key + '.scan.json'), report)
        finally:
            conn.close()
    return {**request, 'settings': settings, 'indexPath': str(db), 'scanReport': report}


class Catalog:
    def __init__(self, request):
        self.request = request
        self.settings = request.get('settings', {})
        self.db = Path(request['indexPath']).resolve()
        if not self.db.is_file():
            raise ValueError('The local photo index is missing. Scan your photo folder in settings.')
        self.conn = sqlite3.connect(self.db.as_uri() + '?mode=ro', uri=True, timeout=5)
        self.conn.row_factory = sqlite3.Row
        required = {'Images', 'Albums', 'AlbumRoots', 'Tags', 'ImageTags', 'ImageInformation', 'Settings'}
        tables = {r[0] for r in self.conn.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        if not required.issubset(tables):
            raise ValueError('The local photo index is incompatible. Restore its backup or rebuild it from the photo folder.')
        self.tables = tables
        self.roots = [dict(r) for r in self.conn.execute('SELECT id,label,status,type,identifier,specificPath FROM AlbumRoots')]
        identity = str(self.db) + json.dumps([(r['id'], r['identifier'], r['specificPath']) for r in self.roots])
        self.key = hashlib.sha256(identity.encode()).hexdigest()[:24]
        self.data = Path(request.get('dataDir', tempfile.gettempdir())) / self.key
        self.journal = self.data / 'journal'
        self.locations_path = self.data / 'locations.json'
        self.locations = json.loads(self.locations_path.read_text()) if self.locations_path.exists() else {}
        self.trash_paths = self.data / 'trashed-paths.json'
        if self.trash_paths.exists():
            restored = json.loads(self.trash_paths.read_text())
            for iid, path in restored.items():
                if self.locations.get(iid, '') is None and Path(path).is_file():
                    self.locations[iid] = path
                    atomic_json(self.locations_path, self.locations)
        self.state_path = self.data / 'pending.json'
        self.pending = json.loads(self.state_path.read_text('utf-8')) if self.state_path.exists() else {}
        self.tag_rows = {r['id']: dict(r) for r in self.conn.execute('SELECT id,pid,name FROM Tags')}
        self.tags = {}
        self.internal = {}
        for tid, row in self.tag_rows.items():
            parts, seen, current = [], set(), tid
            while current in self.tag_rows and current not in seen:
                seen.add(current)
                t = self.tag_rows[current]
                parts.insert(0, t['name'])
                current = t['pid']
            if parts and parts[0] in ['_Photo_Workspace_Labels_', '_Digikam_Internal_Tags_']:
                self.internal[row['name']] = tid
            elif parts:
                self.tags[tid] = '/'.join(parts)
        # TEMP is writable; main remains protected by SQLite's read-only connection.
        self.conn.execute('CREATE TEMP TABLE overlay (imageid INTEGER PRIMARY KEY, rating INTEGER, color INTEGER, pick INTEGER, title TEXT, caption TEXT, tags TEXT)')
        for iid, value in self.pending.items():
            m = value['metadata']
            self.conn.execute('INSERT INTO overlay VALUES (?,?,?,?,?,?,?)', (int(iid), m['rating'], m['color'], m['pick'], m.get('title', ''), m.get('caption', ''), json.dumps(m['tags'])))
        # Finish the TEMP overlay transaction so a file move can update the index
        # through its separate writer even when metadata undo records exist.
        self.conn.commit()
        self.conn.execute('PRAGMA query_only=ON')

    def root_path(self, root):
        return Path(self.settings['photoFolder']).expanduser().resolve()

    def path(self, row, require=False):
        root = next((r for r in self.roots if r['id'] == row['rootId']), None)
        base = self.root_path(root) if root else None
        if base is None:
            if require:
                raise ValueError('Choose an available photo folder in Coherence Photo settings.')
            return None
        override = self.locations.get(str(row['id']))
        if override:
            result = Path(override).resolve()
            if not any(self.root_path(root) and result.is_relative_to(self.root_path(root)) for root in self.roots): raise ValueError('Stored photo location is outside the collection.')
            if require and not result.is_file(): raise ValueError('Photo is offline or missing.')
            return str(result)
        relative = row['relativePath'].replace('\\', '/').lstrip('/')
        result = (base / relative / row['name']).resolve()
        if not result.is_relative_to(base):
            raise ValueError('Photo path escapes its configured collection root.')
        if require and not result.is_file():
            raise ValueError('Photo is offline or missing. Connect the drive and check its collection mapping.')
        return str(result)

    def label_expr(self, prefix, names):
        clauses = []
        for index, name in enumerate(names):
            if index and prefix + name in self.internal:
                tid = self.internal[prefix + name]
                clauses.append(f'WHEN EXISTS(SELECT 1 FROM ImageTags lt WHERE lt.imageid=i.id AND lt.tagid={int(tid)}) THEN {index}')
        return '(CASE ' + ' '.join(clauses) + ' ELSE 0 END)' if clauses else '0'

    def base_sql(self):
        color = self.label_expr('Color Label ', COLORS)
        pick = self.label_expr('Pick Label ', PICKS)
        title = "COALESCE((SELECT comment FROM ImageComments WHERE imageid=i.id AND type=3 ORDER BY CASE WHEN language='x-default' THEN 0 ELSE 1 END,id LIMIT 1),'')" if 'ImageComments' in self.tables else "''"
        caption = "COALESCE((SELECT comment FROM ImageComments WHERE imageid=i.id AND type=1 ORDER BY CASE WHEN language='x-default' THEN 0 ELSE 1 END,id LIMIT 1),'')" if 'ImageComments' in self.tables else "''"
        camera = 'm.model' if 'ImageMetadata' in self.tables else "''"
        lens = 'm.lens' if 'ImageMetadata' in self.tables else "''"
        gps = '(p.latitudeNumber IS NOT NULL AND p.longitudeNumber IS NOT NULL)' if 'ImagePositions' in self.tables else '0'
        return f'''SELECT i.id,i.name,i.album AS albumId,i.fileSize,a.albumRoot AS rootId,a.relativePath,
          COALESCE(o.rating,info.rating,0) AS rating,COALESCE(o.color,{color}) AS color,
          COALESCE(o.pick,{pick}) AS pick,info.creationDate AS date,info.width,info.height,info.format,
          {camera} AS camera,{lens} AS lens,{gps} AS hasGps,
          COALESCE(o.title,{title}) AS title,COALESCE(o.caption,{caption}) AS caption,
          o.tags AS overlayTags, o.imageid AS pendingId
          FROM Images i JOIN Albums a ON a.id=i.album
          LEFT JOIN ImageInformation info ON info.imageid=i.id
          LEFT JOIN overlay o ON o.imageid=i.id
          {'LEFT JOIN ImageMetadata m ON m.imageid=i.id' if 'ImageMetadata' in self.tables else ''}
          {'LEFT JOIN ImagePositions p ON p.imageid=i.id' if 'ImagePositions' in self.tables else ''}
          WHERE i.status=1 AND i.category=1 AND i.id NOT IN ({','.join(str(int(iid)) for iid, value in self.locations.items() if value is None) or '-1'})'''

    def decorate(self, rows):
        if not rows:
            return []
        ids = [r['id'] for r in rows]
        placeholders = ','.join('?' for _ in ids)
        paths = {}
        for row in self.conn.execute(f'SELECT imageid,tagid FROM ImageTags WHERE imageid IN ({placeholders})', ids):
            if row['tagid'] in self.tags:
                paths.setdefault(row['imageid'], []).append(self.tags[row['tagid']])
        result = []
        for item in rows:
            row = dict(item)
            row['tags'] = sorted(json.loads(row.pop('overlayTags'))) if row['overlayTags'] is not None else sorted(paths.get(row['id'], []))
            row['pending'] = row.pop('pendingId') is not None
            row['path'] = self.path(row)
            if str(row['id']) in self.locations and row['path']: row['name'] = Path(row['path']).name
            result.append(row)
        return result

    def photo(self, image_id):
        row = self.conn.execute('SELECT * FROM (' + self.base_sql() + ') WHERE id=?', (int(image_id),)).fetchone()
        if not row:
            raise ValueError('The photo is no longer present in this catalog.')
        return self.decorate([row])[0]

    def photo_folder(self, root_id, relative, image_id):
        override = self.locations.get(str(image_id))
        if override: return os.path.normcase(os.path.dirname(os.path.abspath(override)))
        if not hasattr(self, '_folder_roots'):
            self._folder_roots = {r['id']: self.root_path(r) for r in self.roots}
        root = self._folder_roots.get(root_id)
        return os.path.normcase(os.path.abspath(os.path.join(str(root), relative.replace('\\', '/').lstrip('/')))) if root else ''

    def query(self, filters):
        conditions, params = [], []
        for key, column in [('rootId', 'rootId'), ('albumId', 'albumId')]:
            if filters.get(key) not in (None, ''):
                conditions.append(column + '=?')
                params.append(int(filters[key]))
        if filters.get('folderAbsolute'):
            folder = os.path.normcase(str(Path(filters['folderAbsolute']).resolve()))
            prefix = folder.rstrip(os.sep) + os.sep
            self.conn.create_function('photo_folder', 3, self.photo_folder)
            if filters.get('folderRecursive', True):
                conditions.append('(photo_folder(rootId,relativePath,id)=? OR substr(photo_folder(rootId,relativePath,id),1,?)=?)')
                params.extend([folder, len(prefix), prefix])
            else:
                conditions.append('photo_folder(rootId,relativePath,id)=?')
                params.append(folder)
        if filters.get('folderPath') is not None:
            folder = filters['folderPath'].rstrip('/')
            conditions.append("(relativePath=? OR substr(relativePath,1,length(?)+1)=?||'/')")
            params.extend([folder or '/', folder, folder])
        if filters.get('search'):
            conditions.append('(name LIKE ? ESCAPE "\\" OR title LIKE ? ESCAPE "\\" OR caption LIKE ? ESCAPE "\\")')
            term = filters['search'].replace('\\', '\\\\').replace('%', '\\%').replace('_', '\\_')
            params += ['%' + term + '%'] * 3
        for key in ['color', 'pick', 'rating']:
            if filters.get(key) not in (None, ''):
                conditions.append(key + ('>=?' if key == 'rating' and filters.get('ratingAtLeast', True) else '=?'))
                params.append(int(filters[key]))
        for key, op in [('dateFrom', '>='), ('dateTo', '<=')]:
            if filters.get(key):
                conditions.append('substr(date,1,10)' + op + '?')
                params.append(filters[key])
        for key in ['camera', 'lens', 'format']:
            if filters.get(key):
                conditions.append('COALESCE(' + key + ",'') LIKE ?")
                params.append('%' + filters[key] + '%')
        if filters.get('orientation') == 'landscape':
            conditions.append('width>height')
        elif filters.get('orientation') == 'portrait':
            conditions.append('height>width')
        elif filters.get('orientation') == 'square':
            conditions.append('height=width')
        if filters.get('hasGps') in ['yes', 'no']:
            conditions.append('hasGps=' + ('1' if filters['hasGps'] == 'yes' else '0'))
        if filters.get('tag'):
            tag = filters['tag']
            descendants = filters.get('descendants', True)
            ids = [tid for tid, path in self.tags.items() if path == tag or (descendants and path.startswith(tag + '/'))]
            ids_sql = ','.join(str(int(tid)) for tid in ids) or '-1'
            suffix = " OR substr(j.value,1,length(?)+1)=?||'/'" if descendants else ''
            conditions.append(f'''((overlayTags IS NULL AND EXISTS(SELECT 1 FROM ImageTags t WHERE t.imageid=b.id AND t.tagid IN ({ids_sql})))
              OR (overlayTags IS NOT NULL AND EXISTS(SELECT 1 FROM json_each(overlayTags) j WHERE j.value=?{suffix})))''')
            params.append(tag)
            if descendants:
                params.extend([tag, tag])
        if filters.get('untagged'):
            normal = ','.join(str(tid) for tid in self.tags) or '-1'
            conditions.append(f"((overlayTags IS NOT NULL AND json_array_length(overlayTags)=0) OR (overlayTags IS NULL AND NOT EXISTS(SELECT 1 FROM ImageTags t WHERE t.imageid=b.id AND t.tagid IN ({normal}))))")
        sorts = {'date': 'date', 'name': 'name COLLATE NOCASE', 'rating': 'rating', 'color': 'color', 'pick': 'pick', 'size': 'fileSize'}
        sort = sorts.get(filters.get('sort', 'date'), 'date')
        direction = 'ASC' if filters.get('ascending') else 'DESC'
        where = ' WHERE ' + ' AND '.join(conditions) if conditions else ''
        limit = min(300, max(1, int(filters.get('limit', 120))))
        offset = max(0, int(filters.get('offset', 0)))
        group = ''
        if filters.get('folderAbsolute') and filters.get('groupFolders'):
            def compare_folders(a, b):
                left, right = a.casefold().split(os.sep), b.casefold().split(os.sep)
                return (left > right) - (left < right) or (a > b) - (a < b)
            self.conn.create_collation('PW_FOLDER', compare_folders)
            group = 'photo_folder(rootId,relativePath,id) COLLATE PW_FOLDER ASC,'
        query = 'SELECT * FROM (' + self.base_sql() + ') b' + where + f' ORDER BY {group}{sort} {direction},id {direction} LIMIT ? OFFSET ?'
        rows = self.conn.execute(query, [*params, limit + 1, offset]).fetchall()
        return {'photos': self.decorate(rows[:limit]), 'hasMore': len(rows) > limit, 'offset': offset}

    def catalog(self):
        roots = []
        for root in self.roots:
            row = dict(root)
            resolved = self.root_path(root)
            row['path'] = str(resolved) if resolved else ''
            row['online'] = bool(resolved and resolved.is_dir())
            row['suggestions'] = []
            roots.append(row)
        tag_counts, folder_counts = {}, {}
        visible = {r['id']: r for r in self.conn.execute("SELECT i.id,a.albumRoot AS rootId,a.relativePath FROM Images i JOIN Albums a ON a.id=i.album WHERE i.status=1 AND i.category=1") if self.locations.get(str(r['id']), '') is not None}
        assigned = {}
        for row in self.conn.execute('SELECT imageid,tagid FROM ImageTags'):
            if row['imageid'] in visible and row['tagid'] in self.tags:
                assigned.setdefault(row['imageid'], set()).add(self.tags[row['tagid']])
        for iid, value in self.pending.items():
            if int(iid) in visible: assigned[int(iid)] = set(value['metadata']['tags'])
        for tags in assigned.values():
            ancestors = {'/'.join(tag.split('/')[:depth]) for tag in tags for depth in range(1, len(tag.split('/')) + 1)}
            for tag in ancestors: tag_counts[tag] = tag_counts.get(tag, 0) + 1
        direct = {}
        for iid, row in visible.items():
            folder = self.photo_folder(row['rootId'], row['relativePath'], iid)
            if folder: direct[folder] = direct.get(folder, 0) + 1
        for folder, count in direct.items():
            while folder:
                folder_counts[folder] = folder_counts.get(folder, 0) + count
                parent = os.path.dirname(folder)
                if parent == folder: break
                folder = parent
        version = self.conn.execute("SELECT value FROM Settings WHERE keyword='DBVersion'").fetchone()
        return {'key': self.key, 'version': version[0] if version else 'unknown', 'roots': roots,
                'tags': sorted(tag_counts, key=str.casefold), 'tagCounts': tag_counts, 'folderCounts': folder_counts,
                'albums': [dict(r) for r in self.conn.execute('SELECT id,albumRoot AS rootId,relativePath AS path FROM Albums ORDER BY relativePath')],
                'count': self.conn.execute('SELECT COUNT(*) FROM (' + self.base_sql() + ')').fetchone()[0],
                'pendingCount': len(self.pending)}

    def metadata(self, photo):
        return {key: photo.get(key, '') for key in ['tags', 'rating', 'color', 'pick', 'title', 'caption']}

    def sidecar(self, source):
        if self.settings.get('sidecarNaming') == 'stem':
            result = Path(source).with_suffix('.xmp')
            # A stem sidecar cannot distinguish image.jpg from image.raw in the same folder.
            siblings = [p for p in Path(source).parent.iterdir() if p.stem.casefold() == Path(source).stem.casefold() and p.suffix.lower() not in ['.xmp', '.json'] and p.is_file()]
            if len(siblings) > 1:
                raise ValueError('More than one image shares this filename stem. Use filename.ext.xmp sidecars to avoid changing the wrong image.')
            return result
        return Path(str(source) + '.xmp')

    def write(self, image_id, patch, batch):
        if not patch or not set(patch).issubset(EDITABLE):
            raise ValueError('Unsupported or empty metadata change.')
        for key, maximum in [('rating', 5), ('color', 9), ('pick', 3)]:
            if key in patch and (not isinstance(patch[key], int) or not 0 <= patch[key] <= maximum):
                raise ValueError('Invalid ' + key)
        for key in ['addTags', 'removeTags']:
            if key in patch:
                if not isinstance(patch[key], list) or any(not isinstance(t, str) or not t.strip() or any(not part.strip() for part in t.split('/')) or '|' in t or '\n' in t or '\r' in t for t in patch[key]):
                    raise ValueError('Tags must have nonempty hierarchy components and cannot contain | or newlines.')
        photo = self.photo(image_id)
        source = Path(self.path(photo, require=True))
        tool = exiftool_path(self.settings.get('exiftoolPath', ''))
        embedded = self.settings.get('writeMode', 'embedded') == 'embedded'
        if embedded and source.suffix.lower() not in ['.jpg', '.jpeg', '.png', '.tif', '.tiff', '.webp']:
            raise ValueError('This format does not support embedded writes in Coherence Photo. JPEG, PNG, TIFF and WebP are supported. No file was changed and no sidecar was created. You can explicitly select sidecar mode for other formats.')
        target = source if embedded else self.sidecar(source)
        if target.is_symlink():
            raise ValueError('Metadata writes through a sidecar symlink are not supported.')
        previous = self.pending.get(str(image_id))
        if previous and str(target) != previous['target']:
            raise ValueError('This photo has pending metadata in a different write destination. Undo that batch before changing destinations.')
        if previous and digest(target) != previous['hash']:
            raise ValueError('Metadata changed outside Coherence Photo. Resolve the pending change in settings before writing again.')
        before_hash = digest(target)
        self.journal.mkdir(parents=True, exist_ok=True)
        op_id = uuid.uuid4().hex
        backup = self.journal / (op_id + '.backup')
        if target.exists():
            shutil.copy2(target, backup)
        fd, stage_name = tempfile.mkstemp(dir=target.parent, prefix='.photo-workspace-', suffix=target.suffix)
        os.close(fd)
        stage = Path(stage_name)
        try:
            if target.exists():
                shutil.copy2(target, stage)
            else:
                stage.unlink()
                # Seed the new XMP from the image before overlaying catalog fields.
                exif(tool, ['-TagsFromFile', str(source), '-all:all', '-XMP-xmp:CreatorTool=Coherence Photo', '-o', str(stage), str(source)])
            metadata = self.metadata(photo)
            disk = json.loads(exif(tool, ['-j', '-struct', '-XMP-digiKam:TagsList', '-XMP-lr:HierarchicalSubject', '-XMP-dc:Subject',
                                        '-XMP-xmp:Rating', '-XMP-digiKam:ColorLabel', '-XMP-digiKam:PickLabel',
                                        '-XMP-dc:Title', '-XMP-dc:Description', str(stage)]))[0]
            # Include external tags on the first write; later operations use our acknowledged state.
            if not previous:
                extra = listify(disk.get('TagsList')) + [t.replace('|', '/') for t in listify(disk.get('HierarchicalSubject'))]
                flat = listify(disk.get('Subject'))
                leaves = {t.split('/')[-1] for t in [*metadata['tags'], *extra]}
                extra += [t for t in flat if t not in leaves]
                metadata['tags'] = sorted(set(metadata['tags']) | set(extra))
                if target.exists():
                    for key, disk_key in [('rating', 'Rating'), ('color', 'ColorLabel'), ('pick', 'PickLabel'), ('title', 'Title'), ('caption', 'Description')]:
                        if disk_key in disk:
                            metadata[key] = disk[disk_key] if key in ['title', 'caption'] else int(disk[disk_key])
            metadata['tags'] = sorted((set(metadata['tags']) | set(patch.get('addTags', []))) - set(patch.get('removeTags', [])))
            for key in ['rating', 'color', 'pick', 'title', 'caption']:
                if key in patch:
                    metadata[key] = patch[key]
            args = ['-overwrite_original']
            if 'addTags' in patch or 'removeTags' in patch or not target.exists():
                args += ['-XMP-digiKam:TagsList=', '-XMP-lr:HierarchicalSubject=', '-XMP-dc:Subject=']
                for tag in metadata['tags']:
                    args += ['-XMP-digiKam:TagsList+=' + tag, '-XMP-lr:HierarchicalSubject+=' + tag.replace('/', '|')]
                for tag in sorted({t.split('/')[-1] for t in metadata['tags']}):
                    args.append('-XMP-dc:Subject+=' + tag)
            # A new sidecar must contain baseline catalog fields because applications may prefer it over embedded metadata.
            fields = {'rating': ['XMP-xmp:Rating', 'XMP-acdsee:Rating'], 'color': ['XMP-digiKam:ColorLabel'], 'pick': ['XMP-digiKam:PickLabel'], 'title': ['XMP-dc:Title-x-default'], 'caption': ['XMP-dc:Description-x-default']}
            for key, names in fields.items():
                if key in patch or not target.exists():
                    args += ['-' + name + '=' + str(metadata[key]) for name in names]
            args.append(str(stage))
            exif(tool, args)
            after_hash = digest(stage)
            record = {'id': op_id, 'batch': batch, 'imageId': int(image_id), 'target': str(target), 'source': str(source), 'beforeHash': before_hash, 'afterHash': after_hash, 'backup': str(backup) if before_hash else None,
                      'beforePending': previous, 'metadata': metadata, 'status': 'prepared', 'created': time.time()}
            record_path = self.journal / (op_id + '.json')
            atomic_json(record_path, record)
            if digest(target) != before_hash:
                record['status'] = 'conflict'
                atomic_json(record_path, record)
                raise ValueError('The file changed during this operation; no metadata was replaced.')
            os.replace(stage, target)
            record['status'] = 'committed'
            atomic_json(record_path, record)
            self.pending[str(image_id)] = {'metadata': metadata, 'target': str(target), 'hash': after_hash, 'operation': op_id}
            atomic_json(self.state_path, self.pending)
            return {'id': image_id, 'metadata': metadata, 'operation': op_id, 'status': 'Metadata saved to file'}
        finally:
            if stage.exists():
                stage.unlink()

    def related_files(self, photo):
        source = Path(self.path(photo, require=True))
        result = [source]
        full = Path(str(source) + '.xmp')
        if full.is_file(): result.append(full)
        stem = source.with_suffix('.xmp')
        if stem.is_file() and stem != full:
            siblings = [p for p in source.parent.iterdir() if p.stem == source.stem and p.suffix.lower() in PHOTO_EXTENSIONS]
            if len(siblings) != 1: raise ValueError('A shared sidecar makes this file operation ambiguous. Resolve the shared sidecar first.')
            result.append(stem)
        return result

    def relocate_state(self, iid, pairs):
        mapping = {str(a): str(b) for a, b in pairs}
        def rewrite(value):
            if isinstance(value, dict): return {key: mapping.get(item, item) if key in ['source', 'target'] and isinstance(item, str) else rewrite(item) for key, item in value.items()}
            if isinstance(value, list): return [rewrite(item) for item in value]
            return value
        for record_path in self.journal.glob('*.json'):
            record = json.loads(record_path.read_text())
            if record.get('imageId') == iid: atomic_json(record_path, rewrite(record))
        self.pending = rewrite(self.pending)
        atomic_json(self.state_path, self.pending)
        self.locations[str(iid)] = str(pairs[0][1])
        atomic_json(self.locations_path, self.locations)
        root = self.root_path(self.roots[0]); source, destination = pairs[0]
        with closing(sqlite3.connect(self.db, timeout=30)) as index, index:
            album = '/' + destination.parent.relative_to(root).as_posix().removeprefix('.')
            index.execute('INSERT OR IGNORE INTO Albums(albumRoot,relativePath) VALUES (1,?)', (album,))
            aid = index.execute('SELECT id FROM Albums WHERE relativePath=?', (album,)).fetchone()[0]
            index.execute('UPDATE Images SET album=?,name=? WHERE id=?', (aid, destination.name, iid))
            index.execute('UPDATE FolderFiles SET path=? WHERE imageid=?', (destination.relative_to(root).as_posix(), iid))

    def file_operation(self, iid, operation, destination):
        photo = self.photo(iid)
        files = self.related_files(photo)
        source = files[0]
        target = Path(destination).expanduser().resolve()
        roots = [self.root_path(root) for root in self.roots]
        if not any(root and target.is_relative_to(root) for root in roots):
            raise ValueError('Choose a destination inside the selected photo folder.')
        if not target.parent.is_dir(): raise ValueError('The destination folder does not exist.')
        if target.suffix.lower() != source.suffix.lower(): raise ValueError('Keep the original file extension when renaming a photo.')
        pairs = [(source, target)] + [(path, Path(str(target) + '.xmp') if path.name == source.name + '.xmp' else target.with_suffix('.xmp')) for path in files[1:]]
        if any(dest.exists() for _, dest in pairs): raise ValueError('A file already exists at that destination. Choose another name.')
        if operation == 'move':
            collision = self.conn.execute('SELECT imageid FROM FolderFiles WHERE path=?', (target.relative_to(roots[0]).as_posix(),)).fetchone()
            if collision and collision[0] != iid: raise ValueError('This filename belongs to another indexed photo. Choose a different name.')
        previous = self.pending.get(str(iid))
        if previous and digest(previous['target']) != previous['hash']: raise ValueError('Metadata changed externally. Refresh and resolve that change before moving this photo.')
        hashes = {str(src): digest(src) for src, _ in pairs}
        directory = self.data / 'file-operations'; directory.mkdir(parents=True, exist_ok=True)
        record_path = directory / (uuid.uuid4().hex + '.json')
        record = {'id': iid, 'operation': operation, 'pairs': [[str(a), str(b)] for a,b in pairs], 'hashes': hashes, 'status': 'prepared'}
        atomic_json(record_path, record)
        created = []
        try:
            for src, dest in pairs:
                with open(src, 'rb') as incoming, open(dest, 'xb') as outgoing:
                    shutil.copyfileobj(incoming, outgoing, 1024 * 1024)
                created.append(dest); shutil.copystat(src, dest)
                if digest(src) != hashes[str(src)] or digest(dest) != hashes[str(src)]: raise ValueError('File changed during copying; the operation was cancelled.')
            if operation == 'move':
                for src, _ in pairs: src.unlink()
                self.relocate_state(iid, pairs)
            record['status'] = 'committed'; atomic_json(record_path, record)
            return {'path': str(target)}
        except Exception:
            # Keep destination copies if a source has already moved; recovery completes the references.
            if all(src.exists() for src, _ in pairs):
                for dest in created:
                    if dest.exists(): dest.unlink()
                record['status'] = 'aborted'; atomic_json(record_path, record)
            raise

    def recover_file_operations(self):
        for path in (self.data / 'file-operations').glob('*.json'):
            record = json.loads(path.read_text())
            if record['status'] != 'prepared' or record['operation'] != 'move': continue
            pairs = [(Path(a), Path(b)) for a,b in record['pairs']]
            if all(digest(b) == record['hashes'][str(a)] and (not a.exists() or digest(a) == record['hashes'][str(a)]) for a,b in pairs):
                for source, _ in pairs:
                    if source.exists(): source.unlink()
                self.relocate_state(record['id'], pairs)
                record['status'] = 'committed'; atomic_json(path, record)

    def recover(self):
        if not self.journal.exists():
            return
        records = []
        for path in self.journal.glob('*.json'):
            record = json.loads(path.read_text('utf-8'))
            if record['status'] == 'undo-prepared':
                current = digest(record['target'])
                record['status'] = 'undone' if current == record['beforeHash'] else ('committed' if current == record['afterHash'] else 'conflict')
                atomic_json(path, record)
            elif record['status'] == 'prepared':
                current = digest(record['target'])
                record['status'] = 'committed' if current == record['afterHash'] else ('aborted' if current == record['beforeHash'] else 'conflict')
                atomic_json(path, record)
            records.append(record)
        # Rebuild state from ordered journal, including operations committed before a crash.
        pending = {}
        for record in sorted(records, key=lambda r: r['created']):
            if record['status'] == 'committed':
                pending[str(record['imageId'])] = {'metadata': record['metadata'], 'target': record['target'], 'hash': record['afterHash'], 'operation': record['id']}
            elif record['status'] == 'released':
                pending.pop(str(record['imageId']), None)
        self.pending = pending
        atomic_json(self.state_path, pending)

    def undo(self):
        records = [json.loads(p.read_text('utf-8')) for p in self.journal.glob('*.json')]
        active = [r for r in records if r['status'] == 'committed']
        if not active:
            return {'restored': 0, 'errors': []}
        batch = max(active, key=lambda r: r['created'])['batch']
        restored, errors = 0, []
        for record in sorted([r for r in active if r['batch'] == batch], key=lambda r: r['created'], reverse=True):
            target = Path(record['target'])
            if digest(target) != record['afterHash']:
                errors.append({'id': record['imageId'], 'error': 'File changed externally; undo left it untouched.'})
                continue
            if record['backup'] and digest(record['backup']) != record['beforeHash']:
                errors.append({'id': record['imageId'], 'error': 'Undo backup is missing or changed; original left untouched.'})
                continue
            record['status'] = 'undo-prepared'
            atomic_json(self.journal / (record['id'] + '.json'), record)
            if record['backup']:
                fd, name = tempfile.mkstemp(dir=target.parent, prefix='.photo-undo-', suffix=target.suffix)
                os.close(fd)
                shutil.copy2(record['backup'], name)
                os.replace(name, target)
            else:
                target.unlink()
            record['status'] = 'undone'
            atomic_json(self.journal / (record['id'] + '.json'), record)
            restored += 1
        self.recover()
        return {'restored': restored, 'errors': errors}


def dispatch(request):
    action = request.get('action')
    if action == 'diagnostics':
        result = {'python': sys.version.split()[0], 'sqlite': sqlite3.sqlite_version}
        try:
            tool = exiftool_path(request.get('settings', {}).get('exiftoolPath', ''))
            result.update(exiftool=tool, exiftoolVersion=exif(tool, ['-ver']).strip())
        except ValueError as error:
            result['exiftoolError'] = str(error)
        return result
    prepared = folder_request(request)
    if action == 'scan':
        recovery = Catalog(prepared)
        try: recovery.recover_file_operations()
        finally: recovery.conn.close()
        request = prepared if prepared.get('scanReport') is not None else folder_request(request, scan=True)
    else:
        request = prepared
    cat = Catalog(request)
    try:
        if action in ['catalog', 'scan']:
            result = cat.catalog()
            if request.get('scanReport') is not None: result['scanReport'] = request['scanReport']
            return result
        if action == 'query':
            return cat.query(request.get('filters', {}))
        if action == 'photo':
            return cat.photo(request['id'])
        if action == 'recover':
            cat.recover_file_operations()
            cat.recover()
            return {'pendingCount': len(cat.pending)}
        if action == 'file-operation':
            operation = request['operation']
            if operation not in ['copy', 'move']: raise ValueError('Invalid file action')
            return cat.file_operation(int(request['id']), operation, request['destination'])
        if action == 'file-paths':
            return [str(p) for p in cat.related_files(cat.photo(request['id']))]
        if action == 'file-deleted':
            iid = int(request['id'])
            photo = cat.photo(iid)
            if Path(cat.path(photo)).exists(): raise ValueError('The photo is still present; it was not removed from the collection.')
            trashed = json.loads(cat.trash_paths.read_text()) if cat.trash_paths.exists() else {}
            trashed[str(iid)] = cat.path(photo)
            atomic_json(cat.trash_paths, trashed)
            cat.locations[str(iid)] = None
            atomic_json(cat.locations_path, cat.locations)
            return {'removed': iid}
        if action == 'tag-ids':
            tags = request.get('tags', [request.get('tag')])
            if not isinstance(tags, list) or not tags or any(not isinstance(tag, str) or not tag for tag in tags):
                raise ValueError('Choose valid tags')
            descendants = request.get('descendants', True)
            def matches(value): return any(value == tag or (descendants and value.startswith(tag + '/')) for tag in tags)
            tag_ids = [str(int(tid)) for tid, path in cat.tags.items() if matches(path)]
            ids = {row[0] for row in cat.conn.execute("SELECT DISTINCT i.id FROM Images i JOIN Albums a ON a.id=i.album JOIN ImageTags t ON t.imageid=i.id LEFT JOIN overlay o ON o.imageid=i.id WHERE i.status=1 AND i.category=1 AND o.imageid IS NULL AND t.tagid IN (" + (','.join(tag_ids) or '-1') + ')')}
            for iid, pending in cat.pending.items():
                if any(matches(tag) for tag in pending['metadata']['tags']) and cat.conn.execute('SELECT 1 FROM Images i JOIN Albums a ON a.id=i.album WHERE i.id=? AND i.status=1 AND i.category=1', (int(iid),)).fetchone(): ids.add(int(iid))
            return sorted(iid for iid in ids if cat.locations.get(str(iid), '') is not None)
        if action == 'write':
            if not cat.settings.get('writesEnabled'):
                raise ValueError('Enable metadata writing in Coherence Photo settings first.')
            successes, errors = [], []
            for image_id in request.get('ids', []):
                try:
                    patch = request['patch']
                    change = request.get('tagChange')
                    if change:
                        old, new = change['from'], change.get('to')
                        if not isinstance(old, str) or not old.strip() or (new is not None and (not isinstance(new, str) or not new.strip())):
                            raise ValueError('Invalid tag change')
                        sources = change.get('fromTags', [old])
                        if not sources or any(not isinstance(t, str) or not t.strip() for t in sources) or (len(sources) > 1 and new is not None): raise ValueError('Invalid batch tag deletion')
                        matches = [tag for tag in cat.photo(int(image_id))['tags'] if any(tag == source or (change.get('descendants', True) and tag.startswith(source + '/')) for source in sources)]
                        if not matches:
                            continue
                        patch = {'removeTags': matches, 'addTags': [new + tag[len(old):] for tag in matches] if new else []}
                    successes.append(cat.write(int(image_id), patch, request['batch']))
                except Exception as error:
                    errors.append({'id': image_id, 'error': str(error)})
            return {'successes': successes, 'errors': errors}
        if action == 'undo':
            return cat.undo()
        if action == 'release':
            # Explicitly discard local overlays; does not write image or catalog metadata.
            ids = {int(i) for i in request.get('ids', [])}
            for path in cat.journal.glob('*.json'):
                record = json.loads(path.read_text('utf-8'))
                if record['imageId'] in ids and record['status'] == 'committed':
                    record['status'] = 'released'
                    atomic_json(path, record)
            cat.recover()
            return {'pendingCount': len(cat.pending)}
        if action == 'pending':
            return [{'id': int(key), **value} for key, value in cat.pending.items()]
        if action == 'export-metadata':
            photo = cat.photo(request['id'])
            source = cat.path(photo, require=True)
            target = Path(request['outputPath']).resolve()
            export_root = Path(request['exportRoot']).resolve()
            if not target.is_file() or target.suffix.lower() != '.png' or not target.is_relative_to(export_root) or target == Path(source):
                raise ValueError('Export metadata requires a newly rendered PNG inside the configured export folder.')
            tool = exiftool_path(cat.settings.get('exiftoolPath', ''))
            args = ['-overwrite_original', '-TagsFromFile', source, '-all:all']
            sidecar = cat.sidecar(source)
            if sidecar.is_file() and cat.settings.get('writeMode') != 'embedded':
                args += ['-TagsFromFile', str(sidecar), '-all:all']
            args += ['-XMP-digiKam:TagsList=', '-XMP-lr:HierarchicalSubject=', '-XMP-dc:Subject=']
            for tag in photo['tags']:
                args += ['-XMP-digiKam:TagsList+=' + tag, '-XMP-lr:HierarchicalSubject+=' + tag.replace('/', '|')]
            for tag in sorted({t.split('/')[-1] for t in photo['tags']}):
                args += ['-XMP-dc:Subject+=' + tag]
            args += [f'-XMP-xmp:Rating={photo["rating"]}', f'-XMP-digiKam:ColorLabel={photo["color"]}', f'-XMP-digiKam:PickLabel={photo["pick"]}',
                     '-XMP-dc:Title-x-default=' + photo['title'], '-XMP-dc:Description-x-default=' + photo['caption'],
                     '-Orientation#=1', '-XMP-tiff:Orientation#=1', '-ColorSpace#=1', '-ICC_Profile=',
                     '-ExifImageWidth=' + str(int(request['width'])), '-ExifImageHeight=' + str(int(request['height'])),
                     '-XMP-tiff:ImageWidth=' + str(int(request['width'])), '-XMP-tiff:ImageHeight=' + str(int(request['height'])),
                     '-XMP-digiKam:ImageUniqueID=', '-XMP-digiKam:ImageHistory=', '-XMP-xmpMM:DocumentID=',
                     '-XMP-mwg-rs:RegionInfo=', '-XMP-MP:RegionInfo=', '-ThumbnailImage=', '-PreviewImage=', str(target)]
            exif(tool, args)
            return {'saved': True}
        if action == 'preview':
            photo = cat.photo(request['id'])
            source = cat.path(photo, require=True)
            tool = exiftool_path(cat.settings.get('exiftoolPath', ''))
            for tag in ['PreviewImage', 'JpgFromRaw', 'ThumbnailImage']:
                data = exif(tool, ['-b', '-' + tag, source], binary=True)
                if data.startswith(b'\xff\xd8'):
                    return {'data': base64.b64encode(data).decode(), 'mime': 'image/jpeg', 'embeddedPreview': True}
            raise ValueError('No usable embedded JPEG preview is available for this image.')
        raise ValueError('Unknown bridge action.')
    finally:
        cat.conn.close()


if __name__ == '__main__':
    try:
        request = json.load(sys.stdin)
        print(json.dumps({'ok': True, 'result': dispatch(request)}, ensure_ascii=False))
    except Exception as error:
        print(json.dumps({'ok': False, 'error': str(error)}, ensure_ascii=False))
