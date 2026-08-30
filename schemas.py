"""Pydantic request schemas for the REST API."""

from typing import Optional

from pydantic import BaseModel, Field


class TranscriptLine(BaseModel):
    speaker: str = Field(pattern=r"^(user|ai)$")
    text: str = Field(min_length=1, max_length=10_000)
    timestamp: str = Field(max_length=64)


class SaveTranscriptRequest(BaseModel):
    session_id: str = Field(min_length=1, max_length=128,
                            pattern=r"^[A-Za-z0-9_-]+$")
    topic: str = Field(min_length=1, max_length=500)
    user_side: Optional[str] = Field(default=None, pattern=r"^(Pro|Con)$")
    started_at: Optional[str] = Field(default=None, max_length=64)
    transcript: list[TranscriptLine] = Field(default_factory=list,
                                             max_length=5000)


class RegisterRequest(BaseModel):
    username: str = Field(min_length=3, max_length=64,
                          pattern=r"^[A-Za-z0-9_.-]+$")
    email: str = Field(min_length=5, max_length=255,
                       pattern=r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
    password: str = Field(min_length=8, max_length=128)


class LoginRequest(BaseModel):
    username: str = Field(min_length=1, max_length=255)
    password: str = Field(min_length=1, max_length=128)
