# httpkit

A small HTTP client with automatic retries.

Retries back off exponentially: the first retry waits 100 ms and every later retry waits twice as long as the one before
(100, 200, 400, 800 ...). It gives up after 5 attempts.

See `src/config.mjs` for the settings.
