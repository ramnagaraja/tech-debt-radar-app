"""
Multi-provider LLM calling. Claude uses Anthropic's native SDK; Gemini and
Ollama both expose OpenAI-compatible /chat/completions endpoints, so the
`openai` SDK talks to all three with just a different base_url.

Real endpoints (verified against each vendor's current docs, not guessed):
  - Anthropic: native SDK, api.anthropic.com
  - Gemini:    https://generativelanguage.googleapis.com/v1beta/openai/  (model e.g. gemini-3.5-flash)
  - Ollama:    http://localhost:11434/v1 by default (local, no API key)  (model e.g. qwen2.5, llama3.1)
"""
PROVIDERS = {
    "anthropic": {"label": "Claude (Anthropic)", "default_model": "claude-sonnet-5"},
    "gemini": {"label": "Gemini (Google)", "default_model": "gemini-3.5-flash"},
    "ollama": {"label": "Local (Ollama)", "default_model": "qwen2.5"},
}

DEFAULT_OLLAMA_BASE_URL = "http://localhost:11434/v1"


def call_llm(provider, model, api_key, system, messages, max_tokens=1000, base_url=None):
    """messages: [{"role": "user"|"assistant", "content": str}, ...]. Returns plain text."""
    if not api_key and provider != "ollama":
        raise ValueError(f"No API key configured for provider '{provider}'. Set it in Admin settings.")

    if provider == "anthropic":
        import anthropic
        client = anthropic.Anthropic(api_key=api_key)
        resp = client.messages.create(model=model, max_tokens=max_tokens, system=system, messages=messages)
        text = "".join(b.text for b in resp.content if getattr(b, "type", None) == "text")
        if not text and resp.stop_reason == "max_tokens":
            # The model can spend part of its token budget on internal
            # reasoning before writing any visible text; if that reasoning
            # alone exhausts max_tokens, resp.content has no text block at
            # all. Surfacing this explicitly beats returning "" and letting
            # the caller silently render "No response." with no indication
            # anything went wrong.
            raise RuntimeError(
                f"The model ran out of its {max_tokens}-token response budget before writing any answer "
                "(it spent it on internal reasoning). Try a narrower question, or ask again."
            )
        return text

    if provider == "gemini":
        from openai import OpenAI
        client = OpenAI(api_key=api_key, base_url="https://generativelanguage.googleapis.com/v1beta/openai/")
        resp = client.chat.completions.create(
            model=model, max_tokens=max_tokens,
            messages=[{"role": "system", "content": system}] + messages,
        )
        text = resp.choices[0].message.content or ""
        if not text and resp.choices[0].finish_reason == "length":
            raise RuntimeError(
                f"The model ran out of its {max_tokens}-token response budget before writing any answer. "
                "Try a narrower question, or ask again."
            )
        return text

    if provider == "ollama":
        from openai import OpenAI
        # Ollama's OpenAI-compatible endpoint ignores the API key entirely,
        # but the openai SDK requires some non-empty string to construct a client.
        client = OpenAI(api_key=api_key or "ollama", base_url=base_url or DEFAULT_OLLAMA_BASE_URL)
        try:
            resp = client.chat.completions.create(
                model=model, max_tokens=max_tokens,
                messages=[{"role": "system", "content": system}] + messages,
            )
        except Exception as e:
            raise RuntimeError(
                f"Couldn't reach the local Ollama server at {base_url or DEFAULT_OLLAMA_BASE_URL} "
                f"(is 'ollama serve' running, and is '{model}' pulled?): {e}"
            )
        text = resp.choices[0].message.content or ""
        if not text and resp.choices[0].finish_reason == "length":
            raise RuntimeError(
                f"The model ran out of its {max_tokens}-token response budget before writing any answer. "
                "Try a narrower question, or ask again."
            )
        return text

    raise ValueError(f"Unknown provider: {provider}")
