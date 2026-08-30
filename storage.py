"""Pluggable JSON object storage.

Backends:
  - local (default when S3_BUCKET is unset): a folder on disk — zero config
    for dev and tests.
  - s3 (when S3_BUCKET is set): AWS S3 via boto3; credentials come from the
    standard env vars (AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY /
    AWS_REGION) that Render supplies.

Key layout:
  users/<username_lower>.json            user record
  user_index/email/<email_lower>.json    {"username": ...} lookup index
  transcripts/<user_id>/<id>.json        full transcript record
"""

import asyncio
import json
import os
import shutil
from pathlib import Path

STORAGE_ROOT = os.getenv("STORAGE_ROOT", "./storage")
S3_BUCKET = (os.getenv("S3_BUCKET") or "").strip()


class LocalStore:
    def __init__(self, root: str = STORAGE_ROOT):
        self.root = Path(root).resolve()
        self.root.mkdir(parents=True, exist_ok=True)

    @property
    def label(self) -> str:
        return f"local:{self.root}"

    def _path(self, key: str) -> Path:
        path = (self.root / key).resolve()
        if not str(path).startswith(str(self.root.resolve())):
            raise ValueError("Invalid storage key")
        return path

    async def put(self, key: str, obj: dict):
        path = self._path(key)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(obj, ensure_ascii=False), encoding="utf-8")

    async def get(self, key: str) -> dict | None:
        path = self._path(key)
        if not path.is_file():
            return None
        return json.loads(path.read_text(encoding="utf-8"))

    async def delete(self, key: str):
        self._path(key).unlink(missing_ok=True)

    async def list(self, prefix: str) -> list[str]:
        base = self._path(prefix)
        if not base.is_dir():
            return []
        return [
            str(p.relative_to(self.root)).replace(os.sep, "/")
            for p in sorted(base.rglob("*.json"))
        ]


class S3Store:
    def __init__(self, bucket: str = S3_BUCKET):
        import boto3
        self.bucket = bucket
        self.client = boto3.client("s3")

    @property
    def label(self) -> str:
        return f"s3:{self.bucket}"

    async def put(self, key: str, obj: dict):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        await asyncio.to_thread(
            self.client.put_object, Bucket=self.bucket, Key=key,
            Body=body, ContentType="application/json")

    async def get(self, key: str) -> dict | None:
        def _get():
            try:
                resp = self.client.get_object(Bucket=self.bucket, Key=key)
                return json.loads(resp["Body"].read().decode("utf-8"))
            except self.client.exceptions.NoSuchKey:
                return None
        return await asyncio.to_thread(_get)

    async def delete(self, key: str):
        await asyncio.to_thread(
            self.client.delete_object, Bucket=self.bucket, Key=key)

    async def list(self, prefix: str) -> list[str]:
        def _list():
            keys, token = [], None
            while True:
                kwargs = {"Bucket": self.bucket, "Prefix": prefix}
                if token:
                    kwargs["ContinuationToken"] = token
                resp = self.client.list_objects_v2(**kwargs)
                keys += [o["Key"] for o in resp.get("Contents", [])]
                if not resp.get("IsTruncated"):
                    return keys
                token = resp["NextContinuationToken"]
        return await asyncio.to_thread(_list)


store = S3Store() if S3_BUCKET else LocalStore()
