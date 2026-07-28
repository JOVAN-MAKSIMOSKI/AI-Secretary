"""Environment setup for the fast test suite.

services/storage.py builds the Supabase client at import time and raises without
SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY. Every service module reaches it transitively
(firm_lookup -> storage), so a test that imports one fails during *collection* rather
than at run time, taking the whole suite down with it. A local apps/python/.env hides
this; CI has no .env, which is why the waste-form tests only broke there.

Nothing in tests/ talks to Supabase — every test stubs the client via monkeypatch — so
these values only have to satisfy the import. They are forced rather than defaulted so
the suite provably cannot reach a real project even on a machine with credentials
exported, which is the tests/ contract: pure functions, no network.

The service-role key must be JWT-shaped (three dot-separated segments): supabase-py
regex-validates it inside create_client() and rejects a bare string with "Invalid API
key". No network call happens at construction, so a fake one is enough. evals/eval_env.py
carries its own copy of these guards for the eval process, which does not load this file.
"""

from __future__ import annotations

import os

_SUPABASE_IMPORT_GUARDS = {
    "SUPABASE_URL": "https://test-import-guard.supabase.co",
    "SUPABASE_SERVICE_ROLE_KEY": "test-import-guard.test-import-guard.test-import-guard",
}

for _var, _guard_value in _SUPABASE_IMPORT_GUARDS.items():
    os.environ[_var] = _guard_value
