# @creative/providers

Provider abstraction layer for external AI generation services (image, video, audio, text).

## Core Concepts

- `ProviderAdapter`: Standard interface covering `submit`, `poll`, `parseWebhook`, and `cancel`.
- `ProviderRegistry`: Resolves adapters by capability and optional `region`.
- `MockProvider`: Deterministic reference adapter with HMAC-SHA256 webhook verification, timestamp anti-replay checks, and support for both polling and callback completion modes.
