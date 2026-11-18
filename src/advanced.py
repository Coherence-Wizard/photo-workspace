"""Optional local analysis. Embedded beside the standard-library catalog helper at build time."""
import io
import struct
import urllib.request

ADV_PACKAGES = {'duplicates': ['Pillow>=11,<14'], 'people': ['Pillow>=11,<14', 'opencv-python-headless>=4.10,<5'],
                'semantic': ['Pillow>=11,<14', 'onnxruntime>=1.20,<2', 'tokenizers>=0.21,<1']}
ADV_MODELS = {
    'people': [
        ('opencv/face_detection_yunet', '3cc26e7f1014a5ee5d74a42acee58bafc9d0a310', 'face_detection_yunet_2023mar.onnx', '8f2383e4dd3cfbb4553ea8718107fc0423210dc964f9f4280604804ed2552fa4'),
        ('opencv/face_recognition_sface', '3d7082438a6e4551e840c9b2bb60b71e8da4b524', 'face_recognition_sface_2021dec.onnx', '0ba9fbfa01b5270c96627c4ef784da859931e02f04419c829e83484087c34e79')],
    'semantic': [('Xenova/clip-vit-base-patch32', '6b7c523703ae26e39be4b03774966f8571c7f523', path, checksum) for path, checksum in [
        ('onnx/vision_model_quantized.onnx', '583fd1110a514667812fee7d684952aaf82a99b959760c8d7dca7e0ab9839299'),
        ('onnx/text_model_quantized.onnx', '73baab855d406190da9faa498cfedf65f15cf309f4cc7385b7b032e6d08e5c3a'),
        ('tokenizer.json', 'bc1f77d20440541dd073ebae6f6c401087c7d34e')]]}


def install_advanced(root, feature):
    runtime = root / 'venv'
    executable = runtime / ('Scripts/python.exe' if os.name == 'nt' else 'bin/python')
    if not executable.exists():
        # Use a version with widely available binary wheels, independently of the catalog interpreter.
        candidates = [shutil.which('python3.' + str(n)) for n in (12, 13, 11)]
        candidates += [str(p) for n in (12,13,11) for p in (Path.home()/'.local/share/uv/python').glob(f'cpython-3.{n}*/bin/python3')]
        if os.name == 'nt' and shutil.which('py'):
            import subprocess as sp
            for n in (12,13,11):
                proc = sp.run(['py',f'-3.{n}','-c','import sys;print(sys.executable)'],capture_output=True,text=True)
                if not proc.returncode: candidates.append(proc.stdout.strip())
        interpreter = next((p for p in candidates if p and Path(p).is_file()), sys.executable)
        subprocess.run([interpreter,'-m','venv','--copies',str(runtime)],check=True,stdout=sys.stderr)
    subprocess.run([str(executable), '-m', 'pip', 'install', '--only-binary=:all:', *ADV_PACKAGES[feature]], stdout=sys.stderr, check=True)
    for repo, revision, path, checksum in ADV_MODELS.get(feature, []):
        target = root / Path(path).name
        def matches(file):
            if len(checksum) == 64: return digest(file) == checksum
            data = file.read_bytes()
            return hashlib.sha1(b'blob ' + str(len(data)).encode() + b'\0' + data).hexdigest() == checksum
        if target.exists() and matches(target): continue
        temp = target.with_suffix('.partial')
        with urllib.request.urlopen(f'https://huggingface.co/{repo}/resolve/{revision}/{path}', timeout=90) as response, open(temp, 'wb') as out:
            shutil.copyfileobj(response, out)
        if not matches(temp): raise ValueError('Model download verification failed. Retry setup.')
        os.replace(temp, target)
    atomic_json(root / (feature + '.ready'), True)
    return True


def oriented_image(path, exact=False):
    from PIL import Image, ImageOps, ImageCms
    with Image.open(path) as raw:
        if getattr(raw, 'n_frames', 1) != 1 or raw.mode.startswith(('I', 'F')):
            raise ValueError('Animated, multipage or high-depth image')
        if exact:
            # Pillow can silently reduce precision in multichannel 16-bit images.
            if raw.format == 'PNG':
                with open(path, 'rb') as stream:
                    if stream.read(25)[24] > 8: raise ValueError('High-depth PNG')
            elif raw.format == 'TIFF':
                bits = raw.tag_v2.get(258, 8)
                if max(bits if isinstance(bits, (tuple, list)) else [bits]) > 8:
                    raise ValueError('High-depth TIFF')
            elif raw.format not in ('JPEG','WEBP','GIF','BMP'):
                raise ValueError('Unsupported exact comparison format')
            if raw.mode not in ('1','L','LA','P','RGB','RGBA'): raise ValueError('Unsupported exact comparison color mode')
        img = ImageOps.exif_transpose(raw)
        rgba = img.convert('RGBA')
        if exact:
            rgba.info['icc_profile'] = img.info.get('icc_profile', b'')
            return rgba
        if img.info.get('icc_profile'):
            profile = ImageCms.ImageCmsProfile(io.BytesIO(img.info['icc_profile']))
            rgb = ImageCms.profileToProfile(img.convert('RGB') if img.mode != 'CMYK' else img, profile, ImageCms.createProfile('sRGB'), outputMode='RGB')
            rgb.putalpha(rgba.getchannel('A'))
            return rgb
        return rgba


def pixel_digest(img):
    h = hashlib.sha256(struct.pack('>II', *img.size))
    h.update(hashlib.sha256(img.info.get('icc_profile', b'')).digest())
    for y in range(0, img.height, 128):
        h.update(img.crop((0, y, img.width, min(img.height, y + 128))).tobytes())
    return h.hexdigest()


def unit_vector(value):
    import numpy as np
    v = np.asarray(value, dtype='float32').reshape(-1)
    return v / max(np.linalg.norm(v), 1e-12)


def face_encoder(root):
    import cv2
    import numpy as np
    detector = cv2.FaceDetectorYN.create(str(root / ADV_MODELS['people'][0][2]), '', (320, 320))
    recognizer = cv2.FaceRecognizerSF.create(str(root / ADV_MODELS['people'][1][2]), '')
    def faces(img):
        img.thumbnail((1400, 1400))
        frame = cv2.cvtColor(np.asarray(img), cv2.COLOR_RGBA2BGR)
        detector.setInputSize(img.size)
        found = detector.detect(frame)[1]
        for face in ([] if found is None else found):
            aligned = recognizer.alignCrop(frame, face)
            preview = cv2.imencode('.jpg', aligned)[1].tobytes()
            yield hashlib.sha256(preview).hexdigest(), unit_vector(recognizer.feature(aligned)).tobytes(), preview
    return faces


def clip_session(root, kind):
    import onnxruntime as ort
    ort.disable_telemetry_events()
    return ort.InferenceSession(str(root / (kind + '_model_quantized.onnx')), providers=['CPUExecutionProvider'])


def clip_image(session, img):
    import numpy as np
    from PIL import Image, ImageOps
    rgb = ImageOps.fit(img.convert('RGB'), (224, 224), method=Image.Resampling.BICUBIC)
    x = np.asarray(rgb, dtype='float32') / 255
    x = (x - [0.48145466,0.4578275,0.40821073]) / [0.26862954,0.26130258,0.27577711]
    return unit_vector(session.run(['image_embeds'], {'pixel_values': x.transpose(2,0,1)[None].astype('float32')})[0]).tobytes()


def clip_text(root, text):
    import numpy as np
    from tokenizers import Tokenizer
    tok = Tokenizer.from_file(str(root / 'tokenizer.json'))
    tok.enable_truncation(max_length=77)
    ids = np.array([tok.encode(text).ids], dtype='int64')
    session = clip_session(root, 'text')
    args = {i.name: ids if i.name == 'input_ids' else np.ones_like(ids) for i in session.get_inputs()}
    return unit_vector(session.run(['text_embeds'], args)[0])


def adv_stamp(path):
    st = os.stat(path)
    return f'{st.st_size}:{st.st_mtime_ns}'


def scan_advanced(db, cat, feature, root):
    rows = cat.conn.execute('SELECT i.id,i.name,a.relativePath,a.albumRoot AS rootId FROM Images i JOIN Albums a ON i.album=a.id WHERE i.status=1 AND i.category=1')
    total = cat.conn.execute('SELECT COUNT(*) FROM Images WHERE status=1 AND category=1').fetchone()[0]
    faces = face_encoder(root) if feature == 'people' else None
    model = clip_session(root, 'vision') if feature == 'semantic' else None
    count = errors = reused = 0
    generation = uuid.uuid4().hex
    for row in rows:
        iid = row['id']
        if cat.locations.get(str(iid), '') is None: continue
        count += 1
        try:
            path = cat.path(row, require=True)
            stamp = adv_stamp(path)
            cached = db.execute('SELECT stamp,path FROM items WHERE feature=? AND id=?',(feature,iid)).fetchone()
            if cached == (stamp,path):
                reused += 1
                db.execute('UPDATE items SET generation=? WHERE feature=? AND id=?',(generation,feature,iid))
            else:
                img = oriented_image(path, exact=feature == 'duplicates')
                value = pixel_digest(img) if feature == 'duplicates' else clip_image(model,img) if model else None
                found = list(faces(img)) if faces else []
                if adv_stamp(path) != stamp: raise ValueError('Changed during scan')
                db.execute('INSERT OR REPLACE INTO items VALUES (?,?,?,?,?,?)',(feature,iid,path,stamp,value,generation))
                if faces:
                    db.execute('DELETE FROM faces WHERE id=?',(iid,))
                    db.executemany('INSERT INTO faces VALUES (?,?,?,?)',[(iid,*f) for f in found])
        except (OSError, ValueError, RuntimeError, IndexError) as error:
            errors += 1
            db.execute('DELETE FROM items WHERE feature=? AND id=?',(feature,iid))
        if count % 25 == 0:
            db.commit()
            print('PW_PROGRESS '+json.dumps(dict(processed=count,total=total,errors=errors)),file=sys.stderr,flush=True)
    db.execute('DELETE FROM items WHERE feature=? AND generation<>?',(feature,generation))
    db.execute("DELETE FROM faces WHERE id NOT IN (SELECT id FROM items WHERE feature='people')")
    return dict(processed=count,reused=reused,errors=errors)


def advanced_request(req):
    feature = req['feature']
    if feature not in ADV_PACKAGES: raise ValueError('Unknown advanced feature')
    root = Path(req['dataDir']) / 'advanced'
    if req['action'] == 'advanced-install': return install_advanced(root, feature)
    if req['action'] == 'advanced-status': return (root / (feature+'.ready')).exists()
    if not (root / (feature+'.ready')).exists(): raise ValueError('Set up this tool under Settings → Coherence Photo → Advanced.')
    cat = Catalog(folder_request(req))
    cat.data.mkdir(parents=True,exist_ok=True)
    try:
        with closing(sqlite3.connect(cat.data / 'analysis-v1.sqlite', timeout=30)) as db, db:
            db.execute('PRAGMA journal_mode=WAL')
            db.executescript('''
                CREATE TABLE IF NOT EXISTS items(feature TEXT,id INTEGER,path TEXT,stamp TEXT,value,generation TEXT,PRIMARY KEY(feature,id));
                CREATE INDEX IF NOT EXISTS dup_hash ON items(value) WHERE feature='duplicates';
                CREATE TABLE IF NOT EXISTS faces(id INTEGER,key TEXT,vector BLOB,preview BLOB);
                CREATE INDEX IF NOT EXISTS faces_photo ON faces(id);
                CREATE TABLE IF NOT EXISTS labels(id INTEGER,key TEXT,name TEXT, PRIMARY KEY(id,key));
            ''')
            action = req['action']
            if action == 'advanced-scan': return scan_advanced(db,cat,feature,root)
            offset = max(0,int(req.get('offset',0)))
            if feature == 'duplicates':
                if action == 'advanced-verify':
                    for item in req['items']:
                        photo = cat.photo(item['id'])
                        path = cat.path(photo, require=True)
                        if path != item['path'] or pixel_digest(oriented_image(path, exact=True)) != req['hash']: raise ValueError('Group changed. Rescan before removing copies.')
                    return True
                groups = db.execute("SELECT value FROM items WHERE feature='duplicates' GROUP BY value HAVING COUNT(*)>1 ORDER BY value LIMIT 10 OFFSET ?",(offset,))
                output = []
                for h, in groups:
                    group = []
                    for iid,path in db.execute("SELECT id,path FROM items WHERE feature='duplicates' AND value=? ORDER BY path",(h,)):
                        if cat.locations.get(str(iid), '') is None: continue
                        try: photo = cat.photo(iid)
                        except ValueError: continue
                        if photo['path'] == path:
                            group.append(dict(id=iid,path=path,hash=h,tags=photo['tags'],rating=photo['rating']))
                    if len(group) > 1: output.append(group)
                return output
            import numpy as np
            if feature == 'semantic':
                query = clip_text(root,req['query'])
                import heapq
                scores = ((float(np.frombuffer(v,'float32') @ query),i,p) for i,p,v in db.execute("SELECT id,path,value FROM items WHERE feature='semantic'"))
                return [dict(id=i,path=p,score=s) for s,i,p in heapq.nlargest(40,scores)]
            if action == 'advanced-name':
                name = req['name'].strip()
                if not name or any(c in name for c in '/|,\r\n'): raise ValueError('Enter a single person name.')
                face = db.execute("SELECT path,stamp FROM faces JOIN items USING(id) WHERE feature='people' AND key=? AND id=?",(req['key'],req['id'])).fetchone()
                if not face or adv_stamp(face[0]) != face[1]: raise ValueError('Photo changed. Rescan before naming this face.')
                patch = cat.write(req['id'],{'addTags':['People/'+name]},uuid.uuid4().hex) if cat.settings.get('writesEnabled') else None
                if not patch: raise ValueError('Enable metadata writing to save confirmed People tags.')
                db.execute('INSERT OR REPLACE INTO labels VALUES (?,?,?)',(req['id'],req['key'],name))
                db.execute("UPDATE items SET stamp=? WHERE feature='people' AND id=?",(adv_stamp(face[0]),req['id']))
                return True
            examples = list(db.execute('SELECT DISTINCT name,key,vector FROM labels JOIN faces USING(id,key)'))
            matrix = np.stack([np.frombuffer(e[2],'float32') for e in examples]) if examples else None
            output = []
            for iid,key,v,preview,path in db.execute("SELECT faces.id,key,vector,preview,path FROM faces JOIN items USING(id) LEFT JOIN labels USING(id,key) WHERE feature='people' AND name IS NULL ORDER BY faces.id,key LIMIT 24 OFFSET ?",(offset,)):
                guess = ''
                if matrix is not None:
                    scores = matrix @ np.frombuffer(v,'float32')
                    best = int(np.argmax(scores))
                    if scores[best] >= .65 - .003 * float(req.get('fuzz',50)): guess = examples[best][0]
                output.append(dict(id=iid,key=key,path=path,preview=base64.b64encode(preview).decode(),guess=guess))
            return output
    finally: cat.conn.close()
