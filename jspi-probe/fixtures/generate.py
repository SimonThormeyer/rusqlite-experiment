"""Re-create the immutable read-only fixture with Python's standard SQLite library."""
from pathlib import Path
import sqlite3

destination = Path(__file__).with_name('readonly.sqlite')
with sqlite3.connect(':memory:') as db:
    db.execute('PRAGMA page_size=512')
    db.execute('CREATE TABLE fixture(id INTEGER PRIMARY KEY, label TEXT NOT NULL, payload BLOB NOT NULL)')
    db.executemany('INSERT INTO fixture VALUES (?, ?, ?)', [
        (i, f'row-{i:03}', bytes([i, 0, 255]) + bytes(198) + b'\x5a\xc3') for i in range(1, 101)
    ])
    db.commit()
    content = db.serialize()
    assert len(content) > 512 and content[-2:] == b'\x5a\xc3'
    assert db.execute('PRAGMA integrity_check').fetchone() == ('ok',)
    destination.write_bytes(content)
    print(f'{destination.name}: {len(content)} bytes, {len(content) // 512} pages; SQLite {sqlite3.sqlite_version}')
