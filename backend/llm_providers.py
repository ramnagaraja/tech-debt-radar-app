"""
Multi-provider LLM calling. Claude uses Anthropic's native SDK; Gemini and
Ollama both expose OpenAI-compatible /chat/completions endpoints, so the
`openai` SDK talks to all three with just a different base_url.

Real endpoints (verified against each vendor's current docs, not guessed):
  - Anthropic: native SDK, api.anthropic.com
  - Gemini:    https://generativelanguage.googleapis.com/v1beta/openai/  (model e.g. gemini-3.5-flash)
  - Ollama:    http://localhost:11434/v1 by default (local, no API key)  (model e.g. qwen2.5, llama3.1)
"""
import json
PROVIDERS = {
    "anthropic": {"label": "Claude (Anthropic)", "default_model": "claude-sonnet-5"},
    "gemini": {"label": "Gemini (Google)", "default_model": "gemini-3.5-flash"},
    "ollama": {"label": "Local (Ollama)", "default_model": "qwen2.5"},
}

DEFAULT_OLLAMA_BASE_URL = "http://localhost:11434/v1"


def extract_json(text, expect="object"):
    """Pulls the first well-formed JSON object/array out of an LLM response
    that was asked for "strict JSON" but may still have wrapped it in a
    sentence ("Here's the analysis: {...}") or a ```json fence. Deliberately
    NOT a `re.search(r"\\{.*\\}", text, re.DOTALL)` (this module's earlier
    approach): that greedy regex spans from the first opening brace to the
    LAST closing brace anywhere in the text, so any unrelated brace/bracket
    in surrounding prose (e.g. "the handler({...}) callback") silently pulls
    extra, non-JSON text into the "match" — which then fails to parse with a
    confusing error like "Unterminated string", not a helpful one.

    Instead, this tries the stdlib JSON parser's own `raw_decode` (real
    bracket-matching, not regex) at every occurrence of the opener character
    in turn, returning the first one that actually parses as valid JSON. A
    single `raw_decode` from the first opener isn't enough on its own: if
    the model's lead-in prose itself contains a stray "{" or "[" before the
    real JSON (e.g. "the handler({raw}) callback"), decoding would start —
    and fail — right there. Trying each candidate start in order correctly
    skips past those and finds the real value, wherever it starts."""
    opener = "{" if expect == "object" else "["
    decoder = json.JSONDecoder()
    search_from = 0
    while True:
        idx = text.find(opener, search_from)
        if idx == -1:
            break
        try:
            value, _ = decoder.raw_decode(text, idx)
            return value
        except json.JSONDecodeError:
            search_from = idx + 1
    kind = "object" if expect == "object" else "array"
    raise ValueError(f"No JSON {kind} found in the model's response.")


def call_llm(provider, model, api_key, system, messages, max_tokens=1000, base_url=None, json_mode=False):
    """messages: [{"role": "user"|"assistant", "content": str}, ...]. Returns plain text.

    json_mode: when True (only meaningful for the OpenAI-compatible providers
    below — Gemini and Ollama), asks the API itself to constrain its output
    to valid JSON via response_format, rather than relying on prompt wording
    alone. Some OpenAI-compatible deployments reject the parameter outright;
    if so, this transparently retries the same call without it instead of
    losing the whole request over an unsupported option. Anthropic has no
    equivalent API-level switch, so this is a no-op there — Claude follows a
    strict-JSON system prompt reliably enough on its own."""
    if not api_key and provider != "ollama":
        raise ValueError(f"No API key configured for provider '{provider}'. Set it in Admin settings.")

    if provider == "anthropic":
        import anthropic
        client = anthropic.Anthropic(api_key=api_key)
        resp = client.messages.create(model=model, max_tokens=max_tokens, system=system, messages=messages)
        text = "".join(b.text for b in resp.content if getattr(b, "type", None) == "text")
        if resp.stop_reason == "max_tokens":
            # The model can spend part of its token budget on internal
            # reasoning before writing any visible text (or exhaust it
            # partway through writing the answer); either way, whatever text
            # made it through is truncated and not safe to treat as a
            # complete answer. Surfacing this explicitly beats letting the
            # caller try to parse/render a silently truncated response.
            raise RuntimeError(
                f"The model ran out of its {max_tokens}-token response budget"
                + (" before writing any answer (it spent it on internal reasoning)" if not text else " partway through its answer")
                + ". Try a narrower question, a smaller batch, or ask again."
            )
        return text

    if provider == "gemini":
        from openai import OpenAI
        client = OpenAI(api_key=api_key, base_url="https://generativelanguage.googleapis.com/v1beta/openai/")
        kwargs = dict(model=model, max_tokens=max_tokens, messages=[{"role": "system", "content": system}] + messages)
        if json_mode:
            kwargs["response_format"] = {"type": "json_object"}
        try:
            resp = client.chat.completions.create(**kwargs)
        except Exception:
            if not json_mode:
                raise
            kwargs.pop("response_format", None)
            resp = client.chat.completions.create(**kwargs)
        text = resp.choices[0].message.content or ""
        if resp.choices[0].finish_reason == "length":
            raise RuntimeError(
                f"The model ran out of its {max_tokens}-token response budget"
                + (" before writing any answer" if not text else " partway through its answer")
                + ". Try a narrower question, a smaller batch, or ask again."
            )
        return text

    if provider == "ollama":
        from openai import OpenAI
        # Ollama's OpenAI-compatible endpoint ignores the API key entirely,
        # but the openai SDK requires some non-empty string to construct a client.
        client = OpenAI(api_key=api_key or "ollama", base_url=base_url or DEFAULT_OLLAMA_BASE_URL)
        kwargs = dict(model=model, max_tokens=max_tokens, messages=[{"role": "system", "content": system}] + messages)
        if json_mode:
            kwargs["response_format"] = {"type": "json_object"}
        try:
            resp = client.chat.completions.create(**kwargs)
        except Exception as e:
            if json_mode:
                try:
                    kwargs.pop("response_format", None)
                    resp = client.chat.completions.create(**kwargs)
                except Exception as e2:
                    raise RuntimeError(
                        f"Couldn't reach the local Ollama server at {base_url or DEFAULT_OLLAMA_BASE_URL} "
                        f"(is 'ollama serve' running, and is '{model}' pulled?): {e2}"
                    )
            else:
                raise RuntimeError(
                    f"Couldn't reach the local Ollama server at {base_url or DEFAULT_OLLAMA_BASE_URL} "
                    f"(is 'ollama serve' running, and is '{model}' pulled?): {e}"
                )
        text = resp.choices[0].message.content or ""
        if resp.choices[0].finish_reason == "length":
            raise RuntimeError(
                f"The model ran out of its {max_tokens}-token response budget"
                + (" before writing any answer" if not text else " partway through its answer")
                + ". Try a narrower question, a smaller batch, or ask again."
            )
        return text

    raise ValueError(f"Unknown provider: {provider}")
