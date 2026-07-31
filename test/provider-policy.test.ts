import type { Provider } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import {
  anthropicApiKeyOnlyProvider,
  registerProviderPolicy,
} from "../extensions/autoresearch/provider-policy.ts";

describe("autoresearch provider policy", () => {
  it("keeps Anthropic API-key auth and removes subscription auth", () => {
    const provider = anthropicApiKeyOnlyProvider();

    expect(provider.id).toBe("anthropic");
    expect(provider.auth.apiKey).toBeDefined();
    expect(provider.auth.oauth).toBeUndefined();
  });

  it("replaces the built-in provider through Pi", () => {
    const registerProvider = vi.fn<(provider: Provider) => void>();
    registerProviderPolicy({
      registerProvider,
    } as unknown as ExtensionAPI);

    expect(registerProvider).toHaveBeenCalledOnce();
    expect(registerProvider.mock.calls[0]?.[0]).toMatchObject({
      id: "anthropic",
      auth: {
        apiKey: expect.any(Object),
      },
    });
    expect(registerProvider.mock.calls[0]?.[0].auth.oauth).toBeUndefined();
  });
});
