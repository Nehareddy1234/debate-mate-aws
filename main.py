"""
main.py — LangGraph Debate Brain (V2)

Responsibilities
  - DebateState          : typed session state flowing through the graph
  - DebateReply          : Pydantic schema enforcing the structured payload
  - detect_assist_intent : intent detection ("I'm stuck", "give me a hint")
  - Nodes                : opening_statement | opponent | help_coach
  - Graphs               : app_brain (intent-routed), app_opening, app_help

Every node returns a structured DebateReply:
  rebuttal     -> plain-text voice line (NO markdown, NO emojis, NO lists)
  coaching_tip -> ONE sentence about argument structure
  sticky_note  -> concise bullet summary (max 8 words)

STATE FLOW
  client setup frame -> voice_server builds DebateState
  app_brain   : START -> route_intent -> opponent | help_coach -> END
  app_opening : START -> opening_statement -> END
  app_help    : START -> help_coach -> END
"""

import logging
import os
import re
from typing import Annotated, Optional
from typing_extensions import TypedDict

from dotenv import load_dotenv
from pydantic import BaseModel, Field

from langchain_core.messages import SystemMessage, HumanMessage, AIMessage, BaseMessage
from langchain_openai import ChatOpenAI
from langgraph.graph import StateGraph, START, END
from langgraph.graph.message import add_messages

load_dotenv()

# ─────────────────────────── State ────────────────────────────

class DebateState(TypedDict, total=False):
    messages: Annotated[list[BaseMessage], add_messages]  # full chat history
    topic: str                                            # debate topic
    user_side: str                                        # "Pro" or "Con"
    agent_reply: dict                                     # latest structured reply
    debate_summary: list[str]                             # sticky notes (<=8 words)


# ─────────────────────── Structured output ────────────────────

class DebateReply(BaseModel):
    """Schema every agent node must satisfy (spec §1 structured payload)."""

    rebuttal: str = Field(
        description=(
            "The spoken reply in plain conversational text. "
            "No markdown, no emojis, no bullet points, no numbered lists. "
            "Keep it under 120 words."
        )
    )
    coaching_tip: Optional[str] = Field(
        default=None,
        description=(
            "Exactly ONE sentence coaching the user on argument structure. "
            "Use null when no coaching is warranted."
        ),
    )
    sticky_note: str = Field(
        description=(
            "Concise bullet summary of the core argument. "
            "Maximum 8 words, no trailing punctuation."
        )
    )


# ─────────────────────────── Helpers ──────────────────────────

_EMOJI_RE = re.compile(
    "[\U0001F000-\U0001FAFF\U00002600-\U000027BF\U0001F1E6-\U0001F1FF\uFE0F\u200D]"
)

# Intent detection — phrases that signal the user is stuck or asking for help
_ASSIST_PATTERNS = [
    r"\bgive me a (hint|clue|tip|idea)\b",
    r"\bi'?m stuck\b", r"\bi am stuck\b", r"\bgetting stuck\b",
    r"\bhelp me\b", r"\bcan you help\b", r"\bneed help\b", r"\bsome help\b",
    r"\bwhat should i (say|argue)\b", r"\bi don'?t know what to say\b",
    r"\bno idea what to say\b", r"\brun out of (arguments|ideas)\b",
    r"\bout of arguments\b", r"\blost for words\b", r"\bblank(ed)? out\b",
    r"\bgive me (some )?help\b", r"\bhint please\b", r"\bsuggest something\b",
]
_ASSIST_RE = re.compile("|".join(_ASSIST_PATTERNS), re.IGNORECASE)


def detect_assist_intent(user_text: str) -> bool:
    """True when the user transcript expresses stuckness / asks for help."""
    if not user_text:
        return False
    return bool(_ASSIST_RE.search(user_text))


def _plain_voice(text: str) -> str:
    """Belt-and-braces sanitizer: the model is prompted for plain text,
    but we strip stray markdown/emoji before it reaches TTS."""
    text = _EMOJI_RE.sub("", text or "")
    text = re.sub(r"[#*_`]+", "", text)               # markdown emphasis
    text = re.sub(r"^\s*[-•\d]+[.)]?\s+", "", text, flags=re.MULTILINE)  # bullets
    text = re.sub(r"\s+", " ", text).strip()
    return text


def _last_message_of(state: DebateState, cls) -> str:
    for msg in reversed(state.get("messages", [])):
        if isinstance(msg, cls):
            return msg.content
    return ""


def _structured_llm(temperature: float):
    """
    LLM factory bound to the DebateReply schema (guaranteed JSON shape).

    Provider selection:
      - GOOGLE_API_KEY set  -> Gemini (gemini-1.5-flash) via
                               langchain-google-genai
      - otherwise           -> OpenAI GPT-4o
    Model names are overridable via GOOGLE_MODEL / OPENAI_MODEL env vars.
    """
    if os.getenv("GOOGLE_API_KEY"):
        try:
            from langchain_google_genai import ChatGoogleGenerativeAI
            model = os.getenv("GOOGLE_MODEL", "gemini-3.6-flash")
            return ChatGoogleGenerativeAI(
                model=model, temperature=temperature
            ).with_structured_output(DebateReply)
        except ImportError:
            logging.getLogger(__name__).warning(
                "GOOGLE_API_KEY set but langchain-google-genai is "
                "not installed — falling back to OpenAI.")

    model = os.getenv("OPENAI_MODEL", "gpt-4o")
    # OpenAI-compatible routers (e.g. OmniRoute): point the same client at a
    # different endpoint via OPENAI_BASE_URL / OPENAI_API_BASE in .env.
    base_url = (os.getenv("OPENAI_BASE_URL") or os.getenv("OPENAI_API_BASE") or "").strip()
    kwargs = {"model": model, "temperature": temperature, "streaming": False}
    if base_url:
        kwargs["base_url"] = base_url
    return ChatOpenAI(**kwargs).with_structured_output(DebateReply)


def _opposing_side(user_side: str) -> str:
    return "Con" if user_side == "Pro" else "Pro"


def _store_reply(state: DebateState, reply: DebateReply) -> dict:
    """Common node exit: append AI message, stash reply, grow sticky notes."""
    rebuttal = _plain_voice(reply.rebuttal)
    note = (reply.sticky_note or "").strip().strip(".")
    if len(note.split()) > 8:                    # hard-enforce the 8-word cap
        note = " ".join(note.split()[:8])
    existing = state.get("debate_summary", [])
    return {
        "messages": [AIMessage(content=rebuttal)],
        "agent_reply": {
            "rebuttal": rebuttal,
            "coaching_tip": (reply.coaching_tip or "").strip() or None,
            "sticky_note": note,
        },
        "debate_summary": existing + ([note] if note else []),
    }


_VOICE_RULES = (
    "Voice output rules (CRITICAL):\n"
    "- Plain conversational text only: NO markdown, NO emojis, NO bullet "
    "points, NO numbered lists, NO asterisks.\n"
    "- Vary sentence length. Mix punchy one-liners with developed points.\n"
    "- Keep the rebuttal under 120 words.\n"
    "- coaching_tip must be exactly ONE sentence about argument structure.\n"
    "- sticky_note must be at most 8 words."
)


# ─────────────────────────── Nodes ────────────────────────────

def route_intent(state: DebateState) -> str:
    """
    Conditional edge on app_brain: inspect the last user transcript and
    route to help_coach (assist mode) instead of opponent when the user
    sounds stuck. Runs BEFORE any counter-argument is generated.
    Pure routing function — no state side effects.
    """
    last_user = _last_message_of(state, HumanMessage)
    return "help_coach" if detect_assist_intent(last_user) else "opponent"


async def opponent(state: DebateState) -> dict:
    """
    Node A — Opposing debater.
    Strictly argues the OPPOSITE stance of the user. Structured output:
    rebuttal + optional coaching_tip + sticky_note.
    """
    llm = _structured_llm(temperature=0.85)

    user_side = state.get("user_side", "Pro")
    ai_side   = _opposing_side(user_side)
    topic     = state.get("topic", "an unspecified topic")

    system_prompt = f"""You are an elite competitive debate opponent.

Debate Topic: "{topic}"
Your stance: {ai_side}
User's stance: {user_side}

You MUST argue strictly FOR {ai_side} and AGAINST the user's position.
Never concede the debate, never argue the user's side, never break character.

Style:
- Sharp, articulate, conversational — a real debater, not a textbook.
- Openers like "Look, I understand your point, but...", "Here's the thing —",
  "Let me push back on that:", "Fair point — but consider this:".
- Set coaching_tip only when the user's last argument is weak (short,
  unsupported, or evidence-free); otherwise leave it null.

{_VOICE_RULES}"""

    reply = await llm.ainvoke([SystemMessage(content=system_prompt)] + state["messages"])
    return _store_reply(state, reply)


async def opening_statement(state: DebateState) -> dict:
    """
    Node B — AI opening argument (first_speaker == "AI").
    Speaks from the OPPOSITE stance of the user and ends with a challenge.
    """
    llm = _structured_llm(temperature=0.85)

    user_side = state.get("user_side", "Pro")
    ai_side   = _opposing_side(user_side)
    topic     = state.get("topic", "an unspecified topic")

    system_prompt = f"""You are an elite competitive debater making the opening statement.

Debate Topic: "{topic}"
Your stance: {ai_side}
User's stance: {user_side}

You MUST open strictly FOR {ai_side}, AGAINST the user's position.
- Hook the audience with a compelling, concise opening (under 100 words).
- End with a direct question or challenge aimed at the user.
- Set coaching_tip to null (no coaching on the opening turn).

{_VOICE_RULES}"""

    reply = await llm.ainvoke(
        [SystemMessage(content=system_prompt),
         HumanMessage(content="Please make your opening statement.")]
    )
    return _store_reply(state, reply)


async def help_coach(state: DebateState) -> dict:
    """
    Node C — Assist mode.
    Triggered by intent detection (or the Help button). Supports the USER's
    side with a hint — it must NEVER counter-argue.
    """
    llm = _structured_llm(temperature=0.7)

    user_side = state.get("user_side", "Pro")
    topic     = state.get("topic", "an unspecified topic")
    last_ai   = _last_message_of(state, AIMessage)

    counter_context = (
        f'\nThe AI opponent just said: "{last_ai}"\nHelp the user answer that point.'
        if last_ai else ""
    )

    system_prompt = f"""You are a supportive debate coach helping the user, who is stuck.

Debate Topic: "{topic}"
User's stance: {user_side}
{counter_context}

Your task:
- Give the user a supportive hint for THEIR side ({user_side}).
- Suggest 2-3 concrete angles or talking points they can use.
- You must NEVER argue against the user or defend the opposing side here.
- Be encouraging and practical; open with something like
  "Here's an angle you can use...".
- sticky_note should summarize the hint you are giving, not the opponent's point.

{_VOICE_RULES}"""

    reply = await llm.ainvoke([SystemMessage(content=system_prompt)] + state["messages"])
    return _store_reply(state, reply)


# ─────────────────────────── Graphs ───────────────────────────

def build_graph():
    """Main debate graph: intent-routed between opponent and help_coach."""
    workflow = StateGraph(DebateState)
    workflow.add_node("opponent", opponent)
    workflow.add_node("help_coach", help_coach)

    # START -> router decides: stuck user -> assist mode, otherwise rebut
    workflow.add_conditional_edges(
        START,
        route_intent,
        {"opponent": "opponent", "help_coach": "help_coach"},
    )
    workflow.add_edge("opponent", END)
    workflow.add_edge("help_coach", END)
    return workflow.compile()


def build_opening_graph():
    """Graph for the AI's opening statement when first_speaker == "AI"."""
    workflow = StateGraph(DebateState)
    workflow.add_node("opening_statement", opening_statement)
    workflow.add_edge(START, "opening_statement")
    workflow.add_edge("opening_statement", END)
    return workflow.compile()


def build_help_graph():
    """Graph for explicit help requests (Help button)."""
    workflow = StateGraph(DebateState)
    workflow.add_node("help_coach", help_coach)
    workflow.add_edge(START, "help_coach")
    workflow.add_edge("help_coach", END)
    return workflow.compile()


# Singleton compiled graphs — imported by voice_server.py
app_brain   = build_graph()
app_opening = build_opening_graph()
app_help    = build_help_graph()


# ─────────────────── Quick smoke test ─────────────────────────

if __name__ == "__main__":
    import asyncio

    test_state: DebateState = {
        "messages": [HumanMessage(content="AI will create more jobs than it destroys.")],
        "topic": "Artificial Intelligence is a net positive for society",
        "user_side": "Pro",
        "debate_summary": [],
    }

    async def _smoke():
        print("Running debate brain smoke test...\n")
        return await app_brain.ainvoke(test_state)

    result = asyncio.run(_smoke())
    reply = result["agent_reply"]

    print("=== Rebuttal ===")
    print(reply["rebuttal"])
    print(f"\n=== Coaching Tip ===\n{reply['coaching_tip'] or 'None'}")
    print(f"\n=== Sticky Note ===\n{reply['sticky_note']}")

    print("\n--- Assist intent check ---")
    print('stuck text  ->', detect_assist_intent("I'm stuck, give me a hint"))
    print('normal text ->', detect_assist_intent("Schools should ban smartphones."))
