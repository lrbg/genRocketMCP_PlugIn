/**
 * Autenticación a Microsoft Graph por DEVICE CODE FLOW.
 *
 * El proveedor de Microsoft integrado de VS Code no puede pedir scopes de
 * SharePoint (Sites/Files.Read.All) — da AADSTS65002 (no preautorizado). Aquí se
 * usa el flujo de código de dispositivo con un client_id público (por defecto el
 * de Microsoft Graph PowerShell, preconsentido en muchos tenants) para obtener un
 * token de Graph con esos permisos. Solo HTTP; el usuario autentica en
 * microsoft.com/devicelogin. No se guarda ninguna contraseña.
 */
const authority = (tenant: string) => `https://login.microsoftonline.com/${encodeURIComponent(tenant)}/oauth2/v2.0`

async function form(url: string, body: Record<string, string>): Promise<{ status: number; json: any }> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body).toString(),
  })
  let json: any = {}
  try { json = await res.json() } catch { /* respuesta no JSON */ }
  return { status: res.status, json }
}

export interface DeviceCode {
  user_code: string
  device_code: string
  verification_uri: string
  interval: number
  expires_in: number
  message: string
}

export interface TokenSet {
  access_token: string
  refresh_token?: string
  expires_in: number
}

/** Solicita un código de dispositivo. El usuario lo ingresa en verification_uri. */
export async function requestDeviceCode(clientId: string, tenant: string, scopes: string[]): Promise<DeviceCode> {
  const { status, json } = await form(`${authority(tenant)}/devicecode`, { client_id: clientId, scope: scopes.join(' ') })
  if (status !== 200 || !json.device_code) {
    throw new Error(json.error_description || json.error || `devicecode HTTP ${status}`)
  }
  return json as DeviceCode
}

/** Hace polling hasta que el usuario completa el login o expira el código. */
export async function pollForToken(clientId: string, tenant: string, deviceCode: string, intervalSec: number, expiresInSec: number): Promise<TokenSet> {
  const deadline = Date.now() + Math.max(expiresInSec, 60) * 1000
  let interval = Math.max(intervalSec || 5, 1) * 1000
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, interval))
    const { status, json } = await form(`${authority(tenant)}/token`, {
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      client_id: clientId,
      device_code: deviceCode,
    })
    if (status === 200 && json.access_token) { return json as TokenSet }
    const err = json.error
    if (err === 'authorization_pending') { continue }
    if (err === 'slow_down') { interval += 5000; continue }
    throw new Error(json.error_description || err || `token HTTP ${status}`)
  }
  throw new Error('El código de dispositivo expiró antes de completar el inicio de sesión.')
}

/** Renueva el access_token con el refresh_token guardado. */
export async function refreshAccessToken(clientId: string, tenant: string, scopes: string[], refreshToken: string): Promise<TokenSet> {
  const { status, json } = await form(`${authority(tenant)}/token`, {
    grant_type: 'refresh_token',
    client_id: clientId,
    scope: scopes.join(' '),
    refresh_token: refreshToken,
  })
  if (status !== 200 || !json.access_token) {
    throw new Error(json.error_description || json.error || `refresh HTTP ${status}`)
  }
  return json as TokenSet
}
