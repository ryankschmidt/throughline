type ProfileInput = {
  readonly isDevelopment: boolean;
  readonly branding?: { readonly baseName: string };
};

/** The fork's identity comes from DesktopEnvironment, not an upstream profile name. */
export function legacyProfilePrefix(input: Pick<ProfileInput, "branding">): string {
  return input.branding?.baseName === "ThroughLine"
    ? input.branding.baseName.toLowerCase()
    : "t3code";
}

export function resolveDesktopProfileNames(input: ProfileInput) {
  const prefix = legacyProfilePrefix(input);
  const name = input.branding?.baseName === "ThroughLine" ? input.branding.baseName : "T3 Code";
  return {
    current: `${prefix}-${input.isDevelopment ? "dev" : "v2"}`,
    legacy: `${name} (${input.isDevelopment ? "Dev" : "Alpha"})`,
  };
}
