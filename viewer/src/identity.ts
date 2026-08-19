import type { IdentityHeader } from "./api.ts";

// The publisher identity header: an optional avatar/name/link strip the public
// page renders above a publication (server/publicationPage.ts). It is off by
// default, and "off" is a real state — `identity: null` — not an empty name.
//
// The checks here mirror `normalizeIdentity` in server/publicApp.ts exactly, so
// the two mistakes that cost a round trip (a blank name, a link that isn't
// http(s)) are caught in the form. The server still validates; this only means
// the owner hears about it sooner. When the server does refuse, its own message
// is what gets shown.

export interface IdentityForm {
  name: string;
  avatarAssetId: string;
  linkUrl: string;
  linkLabel: string;
}

export const EMPTY_IDENTITY_FORM: IdentityForm = {
  name: "",
  avatarAssetId: "",
  linkUrl: "",
  linkLabel: "",
};

/** Whether a publication currently shows an identity header. */
export function identityEnabled(identity: IdentityHeader | null | undefined): boolean {
  return !!identity;
}

/** Fill the form from what the publication has, so editing starts where it is. */
export function identityForm(identity: IdentityHeader | null | undefined): IdentityForm {
  if (!identity) return { ...EMPTY_IDENTITY_FORM };
  return {
    name: identity.name,
    avatarAssetId: identity.avatarAssetId ?? "",
    linkUrl: identity.linkUrl ?? "",
    linkLabel: identity.linkLabel ?? "",
  };
}

/**
 * The public URL an avatar asset is served from — the same `<origin>/a/<id>`
 * the public page builds. Null when there is nothing to preview yet.
 */
export function avatarPreviewUrl(origin: string, assetId: string): string | null {
  const id = assetId.trim();
  if (!origin || !id) return null;
  return `${origin.replace(/\/+$/, "")}/a/${encodeURIComponent(id)}`;
}

/** The first thing wrong with the form, or null when the server would take it. */
export function identityError(form: IdentityForm): string | null {
  if (!form.name.trim()) return "A name is required to show an identity header.";
  const url = form.linkUrl.trim();
  if (url) {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return "The link must be a full URL, like https://example.com.";
    }
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      return "The link must start with http:// or https://.";
    }
  }
  return null;
}

/**
 * The PATCH body's `identity` value. Optional fields are omitted rather than
 * sent empty — the server drops empty strings anyway, and omitting keeps the
 * stored record to what the owner actually filled in.
 */
export function identityFromForm(form: IdentityForm): IdentityHeader {
  const identity: IdentityHeader = { name: form.name.trim() };
  const avatar = form.avatarAssetId.trim();
  if (avatar) identity.avatarAssetId = avatar;
  const url = form.linkUrl.trim();
  if (url) identity.linkUrl = url;
  const label = form.linkLabel.trim();
  if (label) identity.linkLabel = label;
  return identity;
}

/**
 * What the link reads as on the public page: the label when there is one, else
 * the host — the same fallback `identityHeader` uses over there.
 */
export function identityLinkText(form: IdentityForm): string {
  const url = form.linkUrl.trim();
  if (!url) return "";
  const label = form.linkLabel.trim();
  if (label) return label;
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}
