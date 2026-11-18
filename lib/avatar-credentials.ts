export const apiKeyLimit = 512;

export type AvatarAccess = {
  enabled: boolean;
  signedIn: boolean;
  signInPath: string | null;
};

export function hasApiKeyFormat(value: string) {
  return value.length <= apiKeyLimit && /^[!-~]+$/.test(value);
}
