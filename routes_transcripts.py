"""Transcript persistence endpoints (object-store backed, per-user)."""

import re
import uuid
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Request, status

from auth import get_current_user
from rate_limit import limiter
from schemas import SaveTranscriptRequest
from storage import store

router = APIRouter()

_ID_RE = re.compile(r"^[A-Za-z0-9-]+$")


async def persist_transcript(user: dict,
                             payload: SaveTranscriptRequest) -> dict:
    record = {
        "id": str(uuid.uuid4()),
        "user_id": user["id"],
        "session_id": payload.session_id,
        "topic": payload.topic,
        "user_side": payload.user_side,
        "started_at": payload.started_at,
        "saved_at": datetime.now(timezone.utc).isoformat(),
        "total_turns": len(payload.transcript),
        "transcript": [line.model_dump() for line in payload.transcript],
    }
    await store.put(f"transcripts/{user['id']}/{record['id']}.json", record)
    return record


@router.post("", status_code=status.HTTP_201_CREATED)
@limiter.limit("30/minute")
async def create_transcript(request: Request,
                            payload: SaveTranscriptRequest,
                            user: dict = Depends(get_current_user)):
    record = await persist_transcript(user, payload)
    return {"id": record["id"], "session_id": record["session_id"],
            "saved_at": record["saved_at"]}


@router.get("")
async def list_transcripts(user: dict = Depends(get_current_user)):
    keys = await store.list(f"transcripts/{user['id']}/")
    records = []
    for key in keys:
        record = await store.get(key)
        if not record:
            continue
        records.append({
            "id": record["id"],
            "session_id": record["session_id"],
            "topic": record["topic"],
            "user_side": record["user_side"],
            "started_at": record["started_at"],
            "saved_at": record["saved_at"],
            "total_turns": record["total_turns"],
        })
    records.sort(key=lambda r: r["saved_at"], reverse=True)
    return {"transcripts": records[:100]}


@router.get("/{transcript_id}")
async def get_transcript(transcript_id: str,
                         user: dict = Depends(get_current_user)):
    if not _ID_RE.match(transcript_id):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Transcript not found")
    record = await store.get(
        f"transcripts/{user['id']}/{transcript_id}.json")
    if record is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Transcript not found")
    return record
