# Judge spec: pi-mcp-bridge cold-start fixes

Review the CURRENT state of the repo (not just the diff - read
extensions/index.ts and README.md in full) against the three contracted
changes from docs/mcp-review-2026-08-10.md (recommended order items 1-3):

1. **Parallel discovery**: server tool discovery (`tools/list` fan-out) must
   run concurrently across servers (not a serial for-await loop), preserve
   CONFIG order in the returned/registered results (deterministic
   collision-prefixing depends on it), and tolerate individual server
   failures (one failure must not abort the others). The session_start path
   must actually use the parallel helper.
2. **Opaque cache key**: the cache key must be a sha256 hex digest of the
   server command+env. No raw argv or env values may be written to the
   cache file. Invalidation semantics must be unchanged (any command/args/
   env change -> different key).
3. **Cache file permissions**: the cache must be written with mode 0600
   (including when the file already exists with wider perms).

Also check README.md documents: the serial->parallel cold-start behaviour,
why the cache file is 0600 + hashed keys, and the recommended pattern for
remote servers with bearer tokens (a wrapper script reading the token from
an env file, never the token in argv).

FAIL on: any stubbed/unimplemented path dressed as done; serial behaviour
hidden behind a concurrency-looking API; the extension's session_start path
bypassing the new helper; the cache file still containing raw config values;
any test weakened or acceptance.test.ts modified (it is out of scope);
paragraph-long comments justifying a workaround instead of the fix.
FAIL on any stale statement anywhere in README/docs that contradicts the
new behaviour. List every finding with file:line.
