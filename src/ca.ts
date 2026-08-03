import * as vscode from 'vscode'
import { execFile } from 'child_process'
import { promisify } from 'util'
import * as path from 'path'

const pexec = promisify(execFile)

/**
 * Genera un bundle PEM con las CAs de confianza del sistema (incluida la CA
 * corporativa que instaló IT) y lo guarda en el almacenamiento de la extensión.
 * Soporta macOS (llavero) y Windows (almacén de certificados). Devuelve la ruta
 * del archivo, o undefined si no se pudo / SO no soportado.
 */
export async function buildCaBundle(context: vscode.ExtensionContext): Promise<string | undefined> {
  let pem = ''

  if (process.platform === 'darwin') {
    for (const kc of [
      '/Library/Keychains/System.keychain',
      '/System/Library/Keychains/SystemRootCertificates.keychain',
    ]) {
      try {
        const { stdout } = await pexec('security', ['find-certificate', '-a', '-p', kc], { maxBuffer: 20 * 1024 * 1024 })
        pem += stdout + '\n'
      } catch { /* seguir */ }
    }
  } else if (process.platform === 'win32') {
    // Exporta el almacén Root (máquina y usuario) a PEM vía PowerShell.
    const ps = "Get-ChildItem Cert:\\LocalMachine\\Root, Cert:\\CurrentUser\\Root | ForEach-Object { '-----BEGIN CERTIFICATE-----'; [Convert]::ToBase64String($_.RawData, 'InsertLineBreaks'); '-----END CERTIFICATE-----' }"
    try {
      const { stdout } = await pexec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { maxBuffer: 30 * 1024 * 1024 })
      pem += stdout
    } catch { /* seguir */ }
  } else {
    return undefined // Linux: normalmente ya usa /etc/ssl/certs; no hace falta
  }

  if (!pem.includes('BEGIN CERTIFICATE')) { return undefined }
  await vscode.workspace.fs.createDirectory(context.globalStorageUri)
  const file = vscode.Uri.joinPath(context.globalStorageUri, 'corp-cacerts.pem')
  await vscode.workspace.fs.writeFile(file, Buffer.from(pem, 'utf8'))
  return file.fsPath
}

/** Ruta esperada del bundle (sin generarlo). */
export function caBundlePath(context: vscode.ExtensionContext): string {
  return path.join(context.globalStorageUri.fsPath, 'corp-cacerts.pem')
}

/** Fija NODE_EXTRA_CA_CERTS para que las apps hereden la CA (macOS: launchctl, Windows: setx). */
export async function setLaunchEnv(file: string): Promise<void> {
  try {
    if (process.platform === 'darwin') {
      await pexec('launchctl', ['setenv', 'NODE_EXTRA_CA_CERTS', file])
    } else if (process.platform === 'win32') {
      await pexec('setx', ['NODE_EXTRA_CA_CERTS', file])
    }
  } catch { /* no crítico; el usuario puede reiniciar igual */ }
}
