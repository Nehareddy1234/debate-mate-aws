"""Auth endpoints: register, login, me (object-store backed)."""

import uuid
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Request, status

from auth import (create_access_token, get_current_user, hash_password,
                  user_payload, verify_password)
from rate_limit import limiter
from schemas import LoginRequest, RegisterRequest
from storage import store

router = APIRouter()


async def _get_user_by_login_ident(ident: str) -> dict | None:
    """Resolve a username-or-email login identifier to a user record."""
    key = ident.strip().lower()
    user = await store.get(f"users/{key}.json")
    if user:
        return user
    index = await store.get(f"user_index/email/{key}.json")
    if index:
        return await store.get(f"users/{index['username']}.json")
    return None


@router.post("/register", status_code=status.HTTP_201_CREATED)
@limiter.limit("5/minute")
async def register(body: RegisterRequest, request: Request):
    username_key = body.username.lower()
    email_key = body.email.lower()
    if (await store.get(f"users/{username_key}.json")
            or await store.get(f"user_index/email/{email_key}.json")):
        raise HTTPException(status.HTTP_409_CONFLICT,
                            "Username or email already exists")

    user = {
        "id": str(uuid.uuid4()),
        "username": body.username,
        "email": body.email,
        "password_hash": hash_password(body.password),
        "created_at": datetime.now(timezone.utc).isoformat(),
    }
    await store.put(f"users/{username_key}.json", user)
    await store.put(f"user_index/email/{email_key}.json",
                    {"username": username_key})
    return {"access_token": create_access_token(user["id"], user["username"]),
            "user": user_payload(user)}


@router.post("/login")
@limiter.limit("10/minute")
async def login(body: LoginRequest, request: Request):
    user = await _get_user_by_login_ident(body.username)
    if user is None or not verify_password(body.password,
                                           user["password_hash"]):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED,
                            "Invalid credentials")
    return {"access_token": create_access_token(user["id"], user["username"]),
            "user": user_payload(user)}


@router.get("/me")
async def me(user: dict = Depends(get_current_user)):
    return {**user_payload(user), "created_at": user["created_at"]}
