import { environment, getPreferenceValues, OAuth } from "@raycast/api";
import { promises as fs } from "fs";
import path from "path";

export type AudioTrackDto = {
  id: string;
  name: string;
  aliases: string[];
  tags: string[];
  isFavorite?: boolean;
};

type MedicBotTokenResponse = {
  accessToken: string;
  accessTokenExpiresIn: number;
  refreshToken: string;
  refreshTokenExpiresIn: number;
};

type Preferences = {
  apiBaseUrl?: string;
  shareableBaseUrl?: string;
  discordClientId?: string;
};

const DEFAULT_API_BASE_URL = "https://api.medicbot.comaristan.com";
const DEFAULT_SHAREABLE_BASE_URL = "https://medicbot.comaristan.com";
const DISCORD_AUTHORIZE_URL = "https://discord.com/api/oauth2/authorize";
const DISCORD_SCOPES = "identify";
const AUDIO_CACHE_DIR = path.join(environment.supportPath, "audio-cache");

const oauthClient = new OAuth.PKCEClient({
  redirectMethod: OAuth.RedirectMethod.Web,
  providerName: "Discord",
  providerIcon: "discord-symbol.png",
  providerId: "medicbot-discord",
  description: "Connect your Discord account to access MedicBot.",
});

function getPreferences() {
  const preferences = getPreferenceValues<Preferences>();
  return {
    apiBaseUrl: normalizeBaseUrl(preferences.apiBaseUrl || DEFAULT_API_BASE_URL),
    shareableBaseUrl: normalizeBaseUrl(preferences.shareableBaseUrl || DEFAULT_SHAREABLE_BASE_URL),
    discordClientId: preferences.discordClientId?.trim(),
  };
}

function normalizeBaseUrl(value: string) {
  return value.replace(/\/+$/, "");
}

function sanitizeFileComponent(value: string) {
  return value.replace(/[^a-z0-9._-]+/gi, "_");
}

function extensionFromContentType(contentType?: string | null) {
  if (!contentType) {
    return "audio";
  }
  const type = contentType.split(";")[0]?.trim().toLowerCase();
  switch (type) {
    case "audio/mpeg":
    case "audio/mp3":
      return "mp3";
    case "audio/m4a":
    case "audio/mp4":
    case "audio/x-m4a":
      return "m4a";
    case "audio/aac":
      return "aac";
    case "audio/wav":
    case "audio/x-wav":
      return "wav";
    case "audio/flac":
      return "flac";
    case "audio/ogg":
      return "ogg";
    case "audio/webm":
      return "webm";
    default:
      if (type?.startsWith("audio/")) {
        const extension = type.split("/")[1];
        if (extension) {
          return extension;
        }
      }
      return "audio";
  }
}

async function ensureAudioCacheDir() {
  await fs.mkdir(AUDIO_CACHE_DIR, { recursive: true });
}

async function findCachedAudioFile(baseName: string) {
  try {
    const entries = await fs.readdir(AUDIO_CACHE_DIR);
    const match = entries.find((entry) => entry.startsWith(`${baseName}.`));
    if (match) {
      return path.join(AUDIO_CACHE_DIR, match);
    }
  } catch {
    return undefined;
  }
  return undefined;
}

async function fetchAudioResponse(audioId: string, token: string) {
  const { apiBaseUrl } = getPreferences();
  const url = `${apiBaseUrl}/Audio/${encodeURIComponent(audioId)}`;
  return fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });
}

async function exchangeDiscordCodeForMedicBot(
  authorizationCode: string,
  request: OAuth.AuthorizationRequest,
): Promise<MedicBotTokenResponse> {
  const { apiBaseUrl, discordClientId } = getPreferences();

  const response = await fetch(`${apiBaseUrl}/Auth/ExchangeDiscordCode`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      code: authorizationCode,
      codeVerifier: request.codeVerifier,
      redirectUri: request.redirectURI,
      clientId: discordClientId,
    }),
  });

  if (!response.ok) {
    throw new Error(`MedicBot token exchange failed with code ${response.status}: ${await response.text()}`);
  }

  return (await response.json()) as MedicBotTokenResponse;
}

async function refreshMedicBotToken(refreshToken: string): Promise<MedicBotTokenResponse> {
  const { apiBaseUrl } = getPreferences();
  const response = await fetch(`${apiBaseUrl}/Auth/Refresh`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ refreshToken }),
  });

  if (!response.ok) {
    throw new Error(`MedicBot refresh failed: ${response.status}`);
  }

  return (await response.json()) as MedicBotTokenResponse;
}

async function authorizeMedicBot(): Promise<MedicBotTokenResponse> {
  const { discordClientId } = getPreferences();
  if (!discordClientId) {
    throw new Error("Missing Discord OAuth Client ID. Set it in the extension preferences.");
  }

  const request = await oauthClient.authorizationRequest({
    endpoint: DISCORD_AUTHORIZE_URL,
    clientId: discordClientId,
    scope: DISCORD_SCOPES,
    extraParameters: {
      prompt: "consent",
    },
  });

  const { authorizationCode } = await oauthClient.authorize(request);
  const medicBotTokens = await exchangeDiscordCodeForMedicBot(authorizationCode, request);

  await oauthClient.setTokens({
    accessToken: medicBotTokens.accessToken,
    refreshToken: medicBotTokens.refreshToken,
    expiresIn: medicBotTokens.accessTokenExpiresIn,
  });

  return medicBotTokens;
}

async function getStoredMedicBotToken(): Promise<OAuth.TokenSet | undefined> {
  return oauthClient.getTokens();
}

export async function getMedicBotAccessToken(): Promise<string> {
  const stored = await getStoredMedicBotToken();

  if (stored?.expiresIn && !stored.isExpired()) {
    return stored.accessToken;
  }

  if (stored?.refreshToken) {
    try {
      const refreshed = await refreshMedicBotToken(stored.refreshToken);
      await oauthClient.setTokens({
        accessToken: refreshed.accessToken,
        refreshToken: refreshed.refreshToken,
        expiresIn: refreshed.accessTokenExpiresIn,
      });
      return refreshed.accessToken;
    } catch {
      await oauthClient.removeTokens();
    }
  }

  const authorized = await authorizeMedicBot();
  return authorized.accessToken;
}

export async function fetchAudioCatalog(): Promise<AudioTrackDto[]> {
  const { apiBaseUrl } = getPreferences();
  const token = await getMedicBotAccessToken();
  const url = `${apiBaseUrl}/Audio?enriched=true`;

  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });

  if (response.status === 401) {
    await oauthClient.removeTokens();
    const refreshedToken = await getMedicBotAccessToken();
    const retryResponse = await fetch(url, {
      headers: {
        Authorization: `Bearer ${refreshedToken}`,
      },
    });

    if (!retryResponse.ok) {
      throw new Error(`MedicBot audio fetch failed: ${retryResponse.status}`);
    }

    return (await retryResponse.json()) as AudioTrackDto[];
  }

  if (!response.ok) {
    throw new Error(`MedicBot audio fetch failed: ${response.status}`);
  }

  return (await response.json()) as AudioTrackDto[];
}

export async function fetchAudioFile(audioId: string): Promise<string> {
  await ensureAudioCacheDir();

  const baseName = `audio-${sanitizeFileComponent(audioId)}`;
  const cached = await findCachedAudioFile(baseName);
  if (cached) {
    return cached;
  }

  const token = await getMedicBotAccessToken();
  let response = await fetchAudioResponse(audioId, token);

  if (response.status === 401) {
    await oauthClient.removeTokens();
    const refreshedToken = await getMedicBotAccessToken();
    response = await fetchAudioResponse(audioId, refreshedToken);
  }

  if (!response.ok) {
    throw new Error(`MedicBot audio download failed: ${response.status}`);
  }

  const contentType = response.headers.get("content-type");
  const extension = extensionFromContentType(contentType);
  const filePath = path.join(AUDIO_CACHE_DIR, `${baseName}.${extension}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  await fs.writeFile(filePath, buffer);

  return filePath;
}

export function buildShareableLink(audioId: string, token?: string) {
  const { shareableBaseUrl } = getPreferences();
  const base = `${shareableBaseUrl}/Audio/${encodeURIComponent(audioId)}`;
  if (!token) {
    return base;
  }
  return `${base}?token=${encodeURIComponent(token)}`;
}
