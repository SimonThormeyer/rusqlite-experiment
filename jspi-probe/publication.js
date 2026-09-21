// Shared by normal xSync and the interruption suite. Hooks are test-only.
export async function publishDatabase(name, bytes, hook = async () => {}) {
  await hook('before-open');
  const root = await navigator.storage.getDirectory();
  const directory = await root.getDirectoryHandle('rusqlite-jspi-probe', { create: true });
  const file = await directory.getFileHandle(name);
  const stream = await file.createWritable();
  try {
    await hook('after-open', stream);
    const midpoint = Math.floor(bytes.length / 2);
    await stream.write(bytes.subarray(0, midpoint));
    await hook('after-half-write', stream);
    await stream.write(bytes.subarray(midpoint));
    await stream.truncate(bytes.length);
    await hook('before-close', stream);
    const closing = stream.close();
    // Attach a handler before suspending at the racing close boundary.
    closing.catch(() => {});
    await hook('close-started');
    await closing;
    await hook('after-close');
  } catch (error) {
    try { await stream.abort(); } catch { /* Preserve the original failure. */ }
    throw error;
  }
}
