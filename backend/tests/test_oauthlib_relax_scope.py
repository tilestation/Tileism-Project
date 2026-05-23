"""
Regression test for the OAUTHLIB scope-relaxation fix
(23 May 2026, exposed by the SEO Self-Audit GSC connect button).

Bug: when our backend requested `openid` + `userinfo.email` scopes,
Google's IdP returned a SUPERSET of scopes (added
`userinfo.profile` for OIDC compliance). `google-auth-oauthlib`
does strict scope-equality checking and raised
  Warning: Scope has changed from "[...]" to "[...]"
which aborted the token exchange. The fix is to set the env var
`OAUTHLIB_RELAX_TOKEN_SCOPE=1` BEFORE google_auth_oauthlib.flow is
imported — both services/gsc.py and services/gbp.py do this at
module load time via os.environ.setdefault.

Contract:
  • Importing services.gsc MUST set OAUTHLIB_RELAX_TOKEN_SCOPE=1.
  • Importing services.gbp MUST also set it (defensive — they both
    depend on the same oauthlib internals).
"""
from __future__ import annotations

import importlib
import os
import sys

import pytest


def _force_reimport(modname: str):
    """Remove the cached module so we can verify the side-effect of
    a fresh import."""
    for k in list(sys.modules.keys()):
        if k == modname or k.startswith(modname + "."):
            del sys.modules[k]


def test_gsc_module_sets_oauthlib_relax(monkeypatch):
    """Loading services.gsc MUST result in OAUTHLIB_RELAX_TOKEN_SCOPE=1
    so the Google OIDC profile-scope expansion doesn't blow up token
    exchange."""
    monkeypatch.delenv("OAUTHLIB_RELAX_TOKEN_SCOPE", raising=False)
    _force_reimport("services.gsc")
    importlib.import_module("services.gsc")
    assert os.environ.get("OAUTHLIB_RELAX_TOKEN_SCOPE") == "1", (
        "services.gsc must set OAUTHLIB_RELAX_TOKEN_SCOPE=1 at import time "
        "to survive Google's OIDC scope expansion (userinfo.profile is "
        "always granted alongside userinfo.email, even when not requested)"
    )


def test_gbp_module_sets_oauthlib_relax(monkeypatch):
    """Same contract for GBP since it shares the OAuth flow internals."""
    monkeypatch.delenv("OAUTHLIB_RELAX_TOKEN_SCOPE", raising=False)
    _force_reimport("services.gbp")
    importlib.import_module("services.gbp")
    assert os.environ.get("OAUTHLIB_RELAX_TOKEN_SCOPE") == "1"


def test_setdefault_respects_explicit_user_override(monkeypatch):
    """If an operator deliberately sets the var to "0" (e.g. to
    re-enable strict scope checking during debug) we MUST NOT overwrite
    it. `os.environ.setdefault` is the right primitive."""
    monkeypatch.setenv("OAUTHLIB_RELAX_TOKEN_SCOPE", "0")
    _force_reimport("services.gsc")
    importlib.import_module("services.gsc")
    assert os.environ["OAUTHLIB_RELAX_TOKEN_SCOPE"] == "0"
