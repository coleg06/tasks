import { importPKCS8, SignJWT } from 'jose';
import type { Env } from '../env';

const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const FOLDER_MIME = 'application/vnd.google-apps.folder';

export type DriveAsset = {
  body: ReadableStream;
  contentType: string;
  eventKey: string;
  eventReference: string;
  eventStartAt: string;
  eventTitle: string;
  filename: string;
  size: number;
  version: number;
  deliverableKey: string;
};

export function driveIsConfigured(env: Env) {
  return Boolean(
    env.GOOGLE_DRIVE_CLIENT_EMAIL &&
      env.GOOGLE_DRIVE_PRIVATE_KEY &&
      env.GOOGLE_DRIVE_ROOT_FOLDER_ID &&
      env.GOOGLE_DRIVE_SHARED_DRIVE_ID,
  );
}

async function accessToken(env: Env) {
  if (!driveIsConfigured(env)) throw new Error('Google Drive delivery is not configured.');
  const privateKey = (env.GOOGLE_DRIVE_PRIVATE_KEY ?? '').replaceAll('\\n', '\n');
  const key = await importPKCS8(privateKey, 'RS256');
  const assertion = await new SignJWT({ scope: DRIVE_SCOPE })
    .setProtectedHeader({ alg: 'RS256', typ: 'JWT' })
    .setIssuer(env.GOOGLE_DRIVE_CLIENT_EMAIL ?? '')
    .setAudience(TOKEN_URL)
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(key);
  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }),
  });
  const payload = (await response.json()) as { access_token?: string; error?: string };
  if (!response.ok || !payload.access_token) {
    throw new Error(`Google authorization failed (${payload.error ?? response.status}).`);
  }
  return payload.access_token;
}

function escapeDriveQuery(value: string) {
  return value.replaceAll('\\', '\\\\').replaceAll("'", "\\'");
}

async function driveJson<T>(token: string, url: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  headers.set('Authorization', `Bearer ${token}`);
  if (init?.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  const response = await fetch(url, { ...init, headers });
  const payload = (await response.json().catch(() => ({}))) as T & {
    error?: { message?: string };
  };
  if (!response.ok) {
    throw new Error(payload.error?.message ?? `Google Drive request failed (${response.status}).`);
  }
  return payload;
}

async function ensureFolder(
  env: Env,
  token: string,
  name: string,
  parentId: string,
): Promise<string> {
  const parameters = new URLSearchParams({
    q: `'${escapeDriveQuery(parentId)}' in parents and name = '${escapeDriveQuery(name)}' and mimeType = '${FOLDER_MIME}' and trashed = false`,
    corpora: 'drive',
    driveId: env.GOOGLE_DRIVE_SHARED_DRIVE_ID ?? '',
    includeItemsFromAllDrives: 'true',
    supportsAllDrives: 'true',
    fields: 'files(id,name)',
    pageSize: '10',
  });
  const listed = await driveJson<{ files: Array<{ id: string; name: string }> }>(
    token,
    `https://www.googleapis.com/drive/v3/files?${parameters}`,
  );
  if (listed.files[0]?.id) return listed.files[0].id;
  const created = await driveJson<{ id: string }>(
    token,
    'https://www.googleapis.com/drive/v3/files?supportsAllDrives=true&fields=id',
    {
      method: 'POST',
      body: JSON.stringify({ name, mimeType: FOLDER_MIME, parents: [parentId] }),
    },
  );
  if (!created.id) throw new Error('Google Drive did not return a folder ID.');
  return created.id;
}

function safeSegment(value: string) {
  const printable = [...value]
    .map((character) => (character.charCodeAt(0) < 32 ? '-' : character))
    .join('');
  return printable
    .normalize('NFKC')
    .replace(/[\\/:*?"<>|]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
}

export async function deliverAssetToDrive(env: Env, asset: DriveAsset) {
  const token = await accessToken(env);
  const eventDate = new Date(asset.eventStartAt);
  const year = Number.isNaN(eventDate.getTime())
    ? new Date().getUTCFullYear().toString()
    : eventDate.getUTCFullYear().toString();
  const yearFolder = await ensureFolder(env, token, year, env.GOOGLE_DRIVE_ROOT_FOLDER_ID ?? '');
  const eventFolder = await ensureFolder(
    env,
    token,
    safeSegment(`${asset.eventReference} ${asset.eventTitle}`),
    yearFolder,
  );
  const metadata = {
    name: safeSegment(asset.filename),
    parents: [eventFolder],
    appProperties: {
      eventKey: asset.eventKey,
      deliverableKey: asset.deliverableKey,
      assetVersion: String(asset.version),
    },
  };
  const start = await fetch(
    'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&supportsAllDrives=true&fields=id,webViewLink',
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json; charset=UTF-8',
        'X-Upload-Content-Length': String(asset.size),
        'X-Upload-Content-Type': asset.contentType,
      },
      body: JSON.stringify(metadata),
    },
  );
  if (!start.ok) {
    const payload = (await start.json().catch(() => ({}))) as { error?: { message?: string } };
    throw new Error(
      payload.error?.message ?? `Google Drive upload could not start (${start.status}).`,
    );
  }
  const location = start.headers.get('Location');
  if (!location) throw new Error('Google Drive did not return an upload location.');
  const uploaded = await fetch(location, {
    method: 'PUT',
    headers: {
      'Content-Length': String(asset.size),
      'Content-Type': asset.contentType,
    },
    body: asset.body,
  });
  const result = (await uploaded.json().catch(() => ({}))) as {
    id?: string;
    webViewLink?: string;
    error?: { message?: string };
  };
  if (!uploaded.ok || !result.id) {
    throw new Error(result.error?.message ?? `Google Drive upload failed (${uploaded.status}).`);
  }
  return {
    id: result.id,
    folderId: eventFolder,
    webViewLink:
      result.webViewLink ?? `https://drive.google.com/open?id=${encodeURIComponent(result.id)}`,
  };
}
