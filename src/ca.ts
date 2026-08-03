import * as vscode from 'vscode'
import { execFile } from 'child_process'
import { promisify } from 'util'
import * as path from 'path'

const pexec = promisify(execFile)

/**
 * Genera un bundle PEM con las CAs del llavero de macOS (incluida la CA
 * corporativa que instaló IT) y lo guarda en el almacenamiento de la extensión.
 * Devuelve la ruta del archivo, o undefined si no es macOS / no se pudo.
 */
export async function buildCaBundle(context: vscode.ExtensionContext): Promise<string | undefined> {
  if (process.platform !== 'darwin') { return undefined }
  const keychains = [
    '/Library/Keychains/System.keychain',
    '/System/Library/Keychains/SystemRootCertificates.keychain',
  ]
  let pem = ''
  for (const kc of keychains) {
    try {
      const { stdout } = await pexec('security', ['find-certificate', '-a', '-p', kc], { maxBuffer: 20 * 1024 * 1024 })
      pem += stdout + '\n'
    } catch { /* keychain no disponible, seguir */ }
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

/** launchctl setenv para que las apps GUI (VS Code) hereden NODE_EXTRA_CA_CERTS. */
export async function setLaunchEnv(file: string): Promise<void> {
  if (process.platform !== 'darwin') { return }
  await pexec('launchctl', ['setenv', 'NODE_EXTRA_CA_CERTS', file])
}
