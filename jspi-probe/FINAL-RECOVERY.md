# Complete the combined recovery stage

This manual test batch covers real quota exhaustion, browser-process termination,
and the recovery decision. Actual quota and each of seven termination boundaries
passed twice. These tests supplement the two successful publication-suite runs
and two writable regression runs already recorded in README.md.

## Prepare one disposable Firefox profile

1. In `about:profiles`, create a profile named `jspi-recovery-test`. Keep it after
   each crash: all runs must use the same profile and origin.
2. Close other Firefox profiles/windows normally. Launch the test profile.
   Force quitting Firefox must not interrupt unrelated browsing or work.
3. In the test profile's `about:config`, set the **Number** preference
   `dom.quotaManager.temporaryStorage.fixedLimit` to **32768**, then restart the
   test profile normally. On macOS use **Firefox → Quit Firefox (Command–Q)**,
   wait for Firefox to exit, then reopen the test profile. Closing its windows or
   reloading the page is insufficient: the quota manager initializes its limit
   once per run. Keep `privacy.resistFingerprinting` false in this disposable
   profile, since the fingerprinting-resistance storage limit takes precedence
   over the fixed-limit preference. Do not enable persistent storage or private browsing.
4. Open [the recovery page](http://localhost:8081/final-recovery.html), using the
   existing probe server. Check the dedicated-profile confirmation box.

Mozilla's [preference definition](https://raw.githubusercontent.com/mozilla-firefox/firefox/main/modules/libpref/init/StaticPrefList.yaml)
provides the temporary-storage override; its
[quota implementation](https://raw.githubusercontent.com/mozilla-firefox/firefox/main/dom/quota/ActorsParent.cpp)
converts the value from KiB to bytes. Thus 32768 limits the temporary storage pool
to 32 MiB; the effective origin/group limit can be smaller. This is real browser
quota enforcement under a reduced limit, rather than a synthetic exception.
The page reports `navigator.storage.estimate()` for diagnostics, but determines
exhaustion from actual OPFS rejections. It independently caps filler bytes at
48 MiB, file attempts at 1024, and the fill loop at two minutes. A large estimate
can indicate that the preference is not active; it does not cause an immediate
failure. If no quota error occurs within the budget, the test fails and removes
its filler files. Check the preference's exact name, Number type, and value in
the running test profile, then fully exit and restart that profile before retrying.

## A. Actual quota exhaustion — twice

Click **Run actual quota checks**. The test:

- Seeds and verifies a committed database.
- Publishes random filler files until actual OPFS operations reject with
  `QuotaExceededError`, refining from 256 KiB allocations to 4 KiB allocations.
- Attempts a real SQL COMMIT inserting a 512 KiB blob, requiring storage growth.
  `xSync` must fail with `SQLITE_IOERR_FSYNC` and a browser `QuotaExceededError`
  cause. The test reports the last publication boundary reached.
- Requires exact old bytes and correct SQL rows/integrity after the failure.
- Deletes filler, commits a new transaction through a fresh connection, and
  verifies a fresh reopen. Successful runs delete the database too.

Failure to reach quota is a failure, not a skip/pass. Filler cleanup runs on
ordinary errors, while a failed database is retained as evidence. Do not force
quit during this quota test. If it is interrupted accidentally, use this disposable
profile's site-data controls to clear the test origin before restarting the batch;
doing so also removes crash checkpoints/databases, so export results first.

Download the results after both runs.

## B. Process termination — each boundary twice

The page lists seven cases: `before-open`, `after-open`, `after-half-write`,
`before-close`, `close-started`, `after-close`, and `commit-returned`. The first six
interrupt COMMIT at publication boundaries. The last tests retention after SQLite
has returned successful COMMIT. Run every case twice (14 forced restarts).

For each run:

1. Select the boundary and click **Prepare crash check**. This generates complete
   old/new reference hashes, resets the old database, and verifies it. The checkpoint
   contains only names, sizes, hashes, and metadata—not a database backup.
2. Click **Download checkpoint** and retain the JSON outside Firefox. Check that
   it is saved, then click **Arm selected boundary**.
3. Wait for **ARMED: [selected boundary]**. On macOS use **Option–Command–Escape**,
   select the test Firefox, and **Force Quit**. Do not use normal Quit, reload,
   tab close, or a renderer-only crash. This is a manual forced application
   shutdown; record if your shutdown method differs.
4. Reopen the same profile and exact recovery-page URL. If the checkpoint is
   absent, import the downloaded JSON. No database is created during verification.
5. Confirm you saw ARMED and force-quit/restarted the profile. Click **Verify after
   process termination**. The page checks a new JS/WASM instance but cannot itself
   distinguish process termination from a reload; that part is explicitly
   manually confirmed.
6. Download results. Select the next case or repeat the current one. Do not clear
   site data between normal runs. Checkpoint recovery from a file is supported
   because localStorage's most recent update may not survive abrupt termination.

Reopening requires exact old bytes before close, either complete version at
`close-started`, and exact new bytes after close or after COMMIT returns. SQL row
contents, `integrity_check`, lock reacquisition, unchanged verification bytes, a
subsequent successful COMMIT on the same file, and another fresh reopen must all
pass. On failure, database and checkpoint remain available for investigation.
The page does not reseed or repair them to turn a failed recovery into a pass.

`close-started` remains a race: manual force quit may happen after close has
completed. Passing this case does not prove interruption inside the underlying
filesystem replacement. Force quitting processes also does not simulate power
loss or dropping the OS disk cache. Neither is claimed by this stage.

If you make a mistake and want to restart a run, reload this page if it is ARMED,
then click **Discard pending run**. This acquires the database's exclusive lock,
removes only the pending test database and checkpoint, and retains completed
results. A discard is recorded separately and never counts as a passing crash
test. If another tab still holds the database, close that tab first. A downloaded
checkpoint from a discarded run cannot resume it; prepare and download a new one.

After the batch, return both quota outputs and all crash results (the downloaded
JSON combines the records). Counters are convenience metadata, not independently
verified evidence of how the browser was terminated. Keep downloaded results
because abrupt shutdown can lose recent browser-side history.

## Recovery decision for this experiment

**Decision: retain the whole-file publication design for the bounded experimental
backend. All checks above passed twice. Do not claim a crash-durable or
production-ready SQLite VFS, and do not add an unverified persistent journal.**

The supported experiment remains one cooperating owner per database, a 1 MiB
whole-file buffer, `journal_mode=MEMORY`, and `cache_spill=OFF`. Each publication
stages a full database and closes the stream; `xClose` never publishes. A failed
publication poisons the current buffer, and callers must reopen before further
work. If an error occurs after publication, callers must inspect application
state before retrying a transaction: a rejected COMMIT is not proof of rollback.

The two existing publication-suite runs support lifecycle recovery at tested
boundaries, including the ambiguous post-close case. The completed final batch
adds evidence for real storage pressure and forced process shutdown. A missing,
partial, inconsistent, or incorrectly versioned database at any required boundary
blocks integration with this design; preserve the evidence and revisit recovery.

Persistent crash durability is a separate requirement that would need a storage
protocol with established publication and durability ordering, retained recovery
state, and tests for that protocol. Adding a conventional SQLite journal file on
top of independently replaced OPFS streams would not by itself establish those
guarantees. That implementation is deferred explicitly rather than considered
validated by this batch. If crash-durable storage becomes a requirement, this
experimental design is insufficient until such a protocol is implemented and
validated. Encryption, WAL, shared readers, and performance are not resolved here.

The combined stage is complete within this bounded recovery decision. Its exit
condition is documented behavior under the tested conditions, including ambiguous
outcomes—not a power-loss claim.
