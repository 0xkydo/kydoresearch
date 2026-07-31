import type { Provider } from "@earendil-works/pi-ai";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * Keep Anthropic API-key authentication while removing the bundled
 * Claude Pro/Max subscription login from this extension and its workers.
 */
export function anthropicApiKeyOnlyProvider(): Provider {
  const provider = builtinProviders().find(
    (candidate) => candidate.id === "anthropic",
  );
  if (!provider) {
    throw new Error("Anthropic provider is unavailable");
  }
  if (!provider.auth.apiKey) {
    throw new Error("Anthropic API-key authentication is unavailable");
  }
  return {
    ...provider,
    auth: { apiKey: provider.auth.apiKey },
  };
}

export function registerProviderPolicy(pi: ExtensionAPI): void {
  pi.registerProvider(anthropicApiKeyOnlyProvider());
}

export default registerProviderPolicy;
