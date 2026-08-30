"""Test environment: dummy keys + throwaway local store BEFORE app imports."""

import os
import shutil
import tempfile

_tmp_root = tempfile.mkdtemp(prefix="dm-tests-")
os.environ["STORAGE_ROOT"] = _tmp_root          # force the local store
os.environ.setdefault("JWT_SECRET", "test-secret")
os.environ.setdefault("DEEPGRAM_API_KEY", "test-deepgram")
# Satisfies the startup provider check; no LLM call is made in tests.
os.environ.setdefault("GOOGLE_API_KEY", "test-google")

import pytest


@pytest.fixture(autouse=True)
def _clean_store():
    shutil.rmtree(_tmp_root, ignore_errors=True)
    os.makedirs(_tmp_root, exist_ok=True)
    yield


@pytest.fixture()
async def client():
    from httpx import ASGITransport, AsyncClient
    from voice_server import app

    app.state.limiter.enabled = False   # rate limits are not what tests exercise
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        yield ac


@pytest.fixture()
async def auth_headers(client):
    r = await client.post("/auth/register", json={
        "username": "tester",
        "email": "tester@example.com",
        "password": "Str0ngPass!",
    })
    assert r.status_code == 201, r.text
    token = r.json()["access_token"]
    return {"Authorization": f"Bearer {token}"}
