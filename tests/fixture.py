"""Disposable digiKam-shaped catalog and original generated PNGs for integration tests."""
import json
from pathlib import Path
import sqlite3
import struct
import zlib


def png(path, width=640, height=420, seed=0):
    def chunk(kind, data):
        return struct.pack('>I', len(data)) + kind + data + struct.pack('>I', zlib.crc32(kind + data) & 0xffffffff)
    data = bytearray()
    palettes = [(79, 125, 149), (174, 129, 101), (112, 140, 119), (131, 121, 159)]
    r, g, b = palettes[seed % len(palettes)]
    for y in range(height):
        data.append(0)
        for x in range(width):
            sky = 1 - y / height
            mountain = y > height * (.60 + .20 * abs((x / width + seed * .13) % .7 - .35))
            sun = (x - width * .72) ** 2 + (y - height * .28) ** 2 < (height * .09) ** 2
            if sun:
                color = (247, 221, 172)
            elif mountain:
                color = (int(r * .50 + 22 * y / height), int(g * .53 + 18 * x / width), int(b * .55))
            else:
                color = (int(r + 45 * sky), int(g + 38 * sky), int(b + 32 * sky))
            data.extend(color)
    content = b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', width, height, 8, 2, 0, 0, 0)) + chunk(b'IDAT', zlib.compress(bytes(data))) + chunk(b'IEND', b'')
    Path(path).write_bytes(content)


def fixture(directory, count=12):
    directory = Path(directory)
    directory.mkdir(parents=True, exist_ok=True)
    root = directory / 'Collection'
    root.mkdir(exist_ok=True)
    db = directory / 'digikam4.db'
    conn = sqlite3.connect(db)
    conn.executescript('''
    CREATE TABLE Settings (keyword TEXT PRIMARY KEY, value TEXT);
    INSERT INTO Settings VALUES ('DBVersion','17');
    CREATE TABLE AlbumRoots (id INTEGER PRIMARY KEY,label TEXT,status INTEGER,type INTEGER,identifier TEXT,specificPath TEXT);
    CREATE TABLE Albums (id INTEGER PRIMARY KEY,albumRoot INTEGER,relativePath TEXT);
    CREATE TABLE Images (id INTEGER PRIMARY KEY,album INTEGER,name TEXT,status INTEGER,category INTEGER,fileSize INTEGER);
    CREATE TABLE ImageInformation (imageid INTEGER PRIMARY KEY,rating INTEGER,creationDate TEXT,width INTEGER,height INTEGER,format TEXT);
    CREATE TABLE ImageMetadata (imageid INTEGER PRIMARY KEY,model TEXT,lens TEXT);
    CREATE TABLE ImageComments (id INTEGER PRIMARY KEY,imageid INTEGER,type INTEGER,language TEXT,comment TEXT);
    CREATE TABLE ImagePositions (imageid INTEGER PRIMARY KEY,latitudeNumber REAL,longitudeNumber REAL);
    CREATE TABLE Tags (id INTEGER PRIMARY KEY,pid INTEGER,name TEXT);
    CREATE TABLE ImageTags (imageid INTEGER,tagid INTEGER,UNIQUE(imageid,tagid));
    INSERT INTO Albums VALUES (1,1,'/');
    INSERT INTO Tags VALUES (1,0,'_Digikam_Internal_Tags_'),(2,0,'Places'),(3,2,'Oregon'),(4,3,'Coast'),(5,0,'Portfolio'),(6,1,'Color Label Blue'),(7,1,'Pick Label Accepted');
    ''')
    conn.execute('INSERT INTO AlbumRoots VALUES (1,?,0,1,?,?)', ('Demo landscapes', 'fixture-volume', str(root)))
    for index in range(1, count + 1):
        name = f'Landscape-{index:02}.png'
        path = root / name
        png(path, seed=index)
        conn.execute('INSERT INTO Images VALUES (?,1,?,1,1,?)', (index, name, path.stat().st_size))
        conn.execute('INSERT INTO ImageInformation VALUES (?,?,?,?,?,?)', (index, index % 6, f'2026-10-{index:02}T10:30:00', 640, 420, 'PNG'))
        conn.execute('INSERT INTO ImageMetadata VALUES (?,?,?)', (index, 'Demo camera', '35mm'))
        conn.execute('INSERT INTO ImageComments VALUES (?,?,1,?,?)', (index, index, 'x-default', f'Original landscape {index}'))
        conn.execute('INSERT INTO ImageTags VALUES (?,?)', (index, 4 if index % 2 else 5))
        if index % 3 == 0:
            conn.executemany('INSERT INTO ImageTags VALUES (?,?)', [(index, 6), (index, 7)])
    conn.commit()
    conn.close()
    return {'databasePath': str(db), 'writesEnabled': True, 'writeMode': 'sidecar', 'sidecarNaming': 'full', 'rootMappings': {'1': str(root)}}


if __name__ == '__main__':
    import sys
    print(json.dumps(fixture(sys.argv[1]), indent=2))
