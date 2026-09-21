// Cooperating SQLite probes use the exact OPFS directory + bare filename as key.
export function databaseLockName(name) {
  if (!name || name === '.' || name === '..' || name.includes('\0') || name.includes('/') || name.includes('\\')) throw new Error('Expected a bare database filename');
  return `rusqlite-jspi-probe:database:${JSON.stringify(name)}`;
}

export function acquireDatabaseLock(name) {
  if (!navigator.locks?.request) throw new Error('This probe requires the Web Locks API');
  const key = databaseLockName(name);
  return new Promise((resolve, reject) => {
    const request = navigator.locks.request(key, { mode: 'exclusive', ifAvailable: true }, lock => {
      if (!lock) {
        const error = new Error('Database is busy in another tab or instance');
        error.name = 'DatabaseBusyError';
        error.sqliteCode = 5; // SQLITE_BUSY at the entry boundary, before opening SQLite.
        throw error;
      }
      return new Promise(release => {
        // Return completion so Rust can await actual lock release on every exit.
        resolve(() => { release(); return request; });
      });
    });
    request.catch(reject);
  });
}
