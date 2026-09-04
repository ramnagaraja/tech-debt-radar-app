"""
Multi-provider LLM calling. Claude uses Anthropic's native SDK; Gemini and
Sarvam both expose OpenAI-compatible /chat/completions endpoints, so the
`openai` SDK talks to all three with just a different base_url.

Real endpoints (verified against each vendor's current docs, not guessed):
  - Anthropic: native SDK, api.anthropic.com
  - Gemini:    https://generativelanguage.googleapis.com/v1beta/openai/  (model e.g. gemini-3.5-flash)
  - Sarvam:    https://api.sarvam.ai/v1                                  (model e.g. sarvam-105b)
"""
PROVIDERS = {
    "anthropic": {"label": "Claude (Anthropic)", "default_model": "claude-sonnet-5"},
    "gemini": {"label": "Gemini (Google)", "default_model": "gemini-3.5-flash"},
    "sarvam": {"label": "Sarvam AI", "default_model": "sarvam-105b"},
}


def call_llm(provider, model, api_key, system, messages, max_tokens=1000):
    """messages: [{"role": "user"|"assistant", "content": str}, ...]. Returns plain text."""
    if not api_key:
        raise ValueError(f"No API key configured for provider '{provider}'. Set it in Admin settings.")

    if provider == "anthropic":
        import anthropic
        client = anthropic.Anthropic(api_key=api_key)
        resp = client.messages.create(model=model, max_tokens=max_tokens, system=system, messages=messages)
        return "".join(b.text for b in resp.content if getattr(b, "type", None) == "text")

    if provider == "gemini":
        from openai import OpenAI
        client = OpenAI(api_key=api_key, base_url="https://generativelanguage.googleapis.com/v1beta/openai/")
        resp = client.chat.completions.create(
            model=model, max_tokens=max_tokens,
            messages=[{"role": "system", "content": system}] + messages,
        )
        return resp.choices[0].message.content or ""

    if provider == "sarvam":
        from openai import OpenAI
        client = OpenAI(api_key=api_key, base_url="https://api.sarvam.ai/v1")
        resp = client.chat.completions.create(
            model=model, max_tokens=max_tokens,
            messages=[{"role": "system", "content": system}] + messages,
        )
        return resp.choices[0].message.content or ""

    raise ValueError(f"Unknown provider: {provider}")
